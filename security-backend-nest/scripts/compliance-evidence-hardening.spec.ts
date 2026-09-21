import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { CompanyMembershipRole, CompanyPermission, hasPermission } from '../src/company-membership/company-membership-types';
import { GuardComplianceService } from '../src/compliance/guard-compliance.service';
import { GuardDocumentType } from '../src/compliance/entities/guard-document.entity';
import { ScreeningController } from '../src/screening/screening.controller';
import { ScreeningService } from '../src/screening/screening.service';
import { ScreeningStatus } from '../src/screening/entities/screening.entities';
import { UserRole, UserStatus } from '../src/user/entities/user.entity';

// 2D3.1 — evidence access permission, verification safety, company-scoped Guard uploads and the
// Company screening outcome projection. The membership mock enforces the REAL ROLE_PERMISSIONS
// matrix, so a denial here proves the permission model rather than a hand-written stub.

const companyA = { id: 11, name: 'Company A' };
const companyB = { id: 22, name: 'Company B' };
const companyC = { id: 33, name: 'Company C' };
const future = '2035-12-31';
const guard = {
  id: 77, fullName: 'Shared Guard', user: { id: 770 },
  siaLicenseNumber: '1234567890123456', siaExpiryDate: future, rightToWorkStatus: 'permanent', rightToWorkExpiryDate: null,
};
const metadata = { originalFileName: 'sia-evidence.pdf', mimeType: 'application/pdf', sizeBytes: 2048 };
const user = (sub: number, role: UserRole) => ({ sub, role, email: `${sub}@test`, status: UserStatus.ACTIVE });

// userId -> membership. Company A staff are 1xx, Company B staff are 2xx.
const memberships: Record<number, { company: { id: number; name: string }; role: CompanyMembershipRole }> = {
  101: { company: companyA, role: CompanyMembershipRole.OWNER },
  102: { company: companyA, role: CompanyMembershipRole.ADMIN },
  103: { company: companyA, role: CompanyMembershipRole.HR_COMPLIANCE },
  104: { company: companyA, role: CompanyMembershipRole.OPERATIONS },
  105: { company: companyA, role: CompanyMembershipRole.CONTROL_ROOM },
  106: { company: companyA, role: CompanyMembershipRole.VIEWER },
  107: { company: companyA, role: CompanyMembershipRole.FINANCE },
  201: { company: companyB, role: CompanyMembershipRole.OWNER },
};
const membership = {
  resolveCompanyContext: async (userId: number, _role: UserRole, permission?: CompanyPermission) => {
    const found = memberships[userId];
    if (!found) throw new NotFoundException('Company not found.');
    if (permission && !hasPermission(found.role, permission)) throw new ForbiddenException('Insufficient permissions.');
    return { company: found.company, membershipRole: found.role };
  },
};

type Link = { id: number; guard: typeof guard; company: { id: number; name: string }; status: string };

function buildHarness(links: Link[], preHireCompanyIds: number[] = []) {
  const documents: any[] = [];
  const audits: any[] = [];
  let nextId = 1;
  const repo = {
    create: (value: any) => ({ id: nextId++, uploadedAt: new Date(), ...value }),
    save: async (value: any) => {
      const index = documents.findIndex((item) => item.id === value.id);
      if (index >= 0) documents[index] = value; else documents.push(value);
      return value;
    },
    find: async ({ where }: any) => documents.filter((document) =>
      (!where.company || document.company?.id === where.company.id) &&
      (!where.guard || document.guard.id === where.guard.id)),
    findOne: async ({ where }: any) => documents.find((document) =>
      document.id === where.id &&
      (!where.company || document.company?.id === where.company.id) &&
      (!where.guard || document.guard.id === where.guard.id)) ?? null,
  };
  const companyGuardRepo = {
    find: async ({ where }: any) => links.filter((link) =>
      (!where.guard || link.guard.id === where.guard.id) &&
      (!where.company || link.company.id === where.company.id) &&
      (!where.status || link.status === where.status)),
  };
  const storage = {
    provider: 's3-compatible',
    createSignedUploadUrl: async ({ key }: any) => ({ url: `https://objects.example/${key}?signature=upload`, expiresAt: new Date(Date.now() + 180000).toISOString(), method: 'PUT', headers: {} }),
    createSignedDownloadUrl: async ({ key }: any) => ({ url: `https://objects.example/${key}?signature=download`, expiresAt: new Date(Date.now() + 180000).toISOString(), method: 'GET' }),
    verifyUpload: async () => undefined,
  };
  const service = new GuardComplianceService(
    repo as any,
    { find: async () => [] } as any,
    companyGuardRepo as any,
    membership as any,
    { findOne: async () => guard, findByUserId: async (id: number) => (id === 770 ? guard : null) } as any,
    {} as any,
    { log: async (entry: any) => (audits.push(entry), entry) } as any,
    { authorize: async (companyId: number) => { if (!preHireCompanyIds.includes(companyId)) throw new ForbiddenException('no pre-hire application'); return { guard, companyId }; } } as any,
    storage as any,
  );
  return { service, documents, audits };
}

const activeLinks = (companies = [companyA, companyB]): Link[] => companies.map((company, index) => ({ id: index + 1, guard, company, status: 'ACTIVE' }));

async function uploadCompleted(service: GuardComplianceService, companyUser: number, type = GuardDocumentType.SIA_LICENCE) {
  const uploaded = await service.uploadDocumentForCompanyUser(companyUser, UserRole.COMPANY_ADMIN, { guardId: guard.id, type, ...metadata, expiryDate: future });
  await service.completeDocumentUpload(user(companyUser, UserRole.COMPANY_ADMIN), uploaded.id);
  return uploaded;
}

async function expectDenied(work: () => Promise<unknown>, kind: 'forbidden' | 'notfound' = 'forbidden') {
  let error: unknown;
  try { await work(); } catch (caught) { error = caught; }
  ok(error instanceof (kind === 'forbidden' ? ForbiddenException : NotFoundException), `expected ${kind}, got ${String(error)}`);
}

let count = 0;
async function test(name: string, work: () => Promise<void>) {
  await work();
  count += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  // ---- ACCESS: evidence file needs compliance.manage -------------------------------------------
  await test('ACCESS-MANAGER: owner, admin and HR/compliance receive a temporary signed URL', async () => {
    const { service, audits } = buildHarness(activeLinks());
    const doc = await uploadCompleted(service, 101);
    for (const id of [101, 102, 103]) {
      const access = await service.createDocumentAccess(user(id, UserRole.COMPANY_STAFF), doc.id);
      equal(access.method, 'GET');
      ok(access.url.includes('signature=download'));
      ok(!JSON.stringify(access).includes('storageKey'));
    }
    equal(audits.filter((entry) => entry.action === 'guard_document.accessed').length, 3);
  });

  await test('ACCESS-VIEWER-DENIED: viewer (compliance.view) cannot obtain evidence', async () => {
    const { service, audits } = buildHarness(activeLinks());
    const doc = await uploadCompleted(service, 101);
    await expectDenied(() => service.createDocumentAccess(user(106, UserRole.COMPANY_STAFF), doc.id));
    equal(audits.filter((entry) => entry.action === 'guard_document.accessed').length, 0);
  });

  await test('ACCESS-CONTROL-DENIED: control room (compliance.view) cannot obtain evidence', async () => {
    const { service } = buildHarness(activeLinks());
    const doc = await uploadCompleted(service, 101);
    await expectDenied(() => service.createDocumentAccess(user(105, UserRole.COMPANY_STAFF), doc.id));
  });

  await test('ACCESS-OPERATIONS-DENIED: operations has compliance.view but not compliance.manage', async () => {
    ok(hasPermission(CompanyMembershipRole.OPERATIONS, CompanyPermission.COMPLIANCE_VIEW));
    ok(!hasPermission(CompanyMembershipRole.OPERATIONS, CompanyPermission.COMPLIANCE_MANAGE));
    const { service } = buildHarness(activeLinks());
    const doc = await uploadCompleted(service, 101);
    await expectDenied(() => service.createDocumentAccess(user(104, UserRole.COMPANY_STAFF), doc.id));
  });

  await test('ACCESS-FINANCE-DENIED: finance has no compliance permission at all', async () => {
    const { service } = buildHarness(activeLinks());
    const doc = await uploadCompleted(service, 101);
    await expectDenied(() => service.createDocumentAccess(user(107, UserRole.COMPANY_STAFF), doc.id));
  });

  await test('ACCESS-TENANT-ISOLATION: a Company B manager cannot obtain Company A evidence', async () => {
    const { service } = buildHarness(activeLinks());
    const doc = await uploadCompleted(service, 101);
    await expectDenied(() => service.createDocumentAccess(user(201, UserRole.COMPANY_ADMIN), doc.id), 'notfound');
  });

  await test('LIST-STATUS-PRESERVED: view-only roles still see document type/status/expiry without any file URL', async () => {
    const { service } = buildHarness(activeLinks());
    const doc = await uploadCompleted(service, 101);
    for (const id of [104, 105, 106]) {
      const list = await service.listDocumentsForCompanyUser(id, UserRole.COMPANY_STAFF, guard.id);
      equal(list.length, 1);
      equal(list[0].id, doc.id);
      equal(list[0].type, GuardDocumentType.SIA_LICENCE);
      equal(list[0].expiryDate, future);
      ok(list[0].uploadCompletedAt instanceof Date);
      const text = JSON.stringify(list);
      ok(!text.includes('storageKey') && !text.includes('fileUrl') && !text.includes('signature='));
    }
    await expectDenied(() => service.listDocumentsForCompanyUser(107, UserRole.COMPANY_STAFF, guard.id));
  });

  // ---- VERIFY ----------------------------------------------------------------------------------
  await test('VERIFY-MANAGER: manager verifies a completed document and the actor is recorded', async () => {
    const { service, audits } = buildHarness(activeLinks());
    const doc = await uploadCompleted(service, 101);
    const verified = await service.verifyDocumentForCompanyUser(103, UserRole.COMPANY_STAFF, doc.id, true);
    equal(verified.verified, true);
    equal(verified.verifiedByUserId, 103);
    ok(verified.verifiedAt instanceof Date);
    equal(audits.filter((entry) => entry.action === 'guard_document.verified').length, 1);
  });

  await test('VERIFY-VIEWER-DENIED: viewer, operations and control room cannot verify', async () => {
    const { service, documents } = buildHarness(activeLinks());
    const doc = await uploadCompleted(service, 101);
    for (const id of [104, 105, 106]) {
      await expectDenied(() => service.verifyDocumentForCompanyUser(id, UserRole.COMPANY_STAFF, doc.id, true));
    }
    equal(documents[0].verified, false);
  });

  await test('VERIFY-INCOMPLETE-BLOCKED: a document whose upload is incomplete cannot be verified', async () => {
    const { service, documents } = buildHarness(activeLinks());
    const uploaded = await service.uploadDocumentForCompanyUser(101, UserRole.COMPANY_ADMIN, { guardId: guard.id, type: GuardDocumentType.SIA_LICENCE, ...metadata });
    equal(uploaded.uploadCompletedAt, null);
    await rejects(() => service.verifyDocumentForCompanyUser(101, UserRole.COMPANY_ADMIN, uploaded.id, true), BadRequestException);
    equal(documents[0].verified, false);
  });

  // ---- GUARD SELF-UPLOAD: company scoped ------------------------------------------------------
  await test('GUARD-UPLOAD-COMPANY-A: guard upload is scoped to the chosen company and visible to it', async () => {
    const { service, documents, audits } = buildHarness(activeLinks());
    const uploaded = await service.uploadDocumentForGuardUser(770, { type: GuardDocumentType.SIA_LICENCE, ...metadata, companyId: companyA.id });
    equal(uploaded.company!.id, companyA.id);
    equal(documents[0].company.id, companyA.id);
    ok(uploaded.upload.url.includes(`/compliance/company/${companyA.id}/${guard.id}/`));
    equal(audits[0].company.id, companyA.id);
    equal(audits[0].user.id, 770);
    await service.completeDocumentUpload(user(770, UserRole.GUARD), uploaded.id);
    const visibleToA = await service.listDocumentsForCompanyUser(101, UserRole.COMPANY_ADMIN, guard.id);
    equal(visibleToA.length, 1);
    equal(visibleToA[0].id, uploaded.id);
    equal((await service.listDocumentsForCompanyUser(201, UserRole.COMPANY_ADMIN, guard.id)).length, 0);
    // Company A can now open it; Company B cannot.
    await service.createDocumentAccess(user(101, UserRole.COMPANY_ADMIN), uploaded.id);
    await expectDenied(() => service.createDocumentAccess(user(201, UserRole.COMPANY_ADMIN), uploaded.id), 'notfound');
  });

  await test('GUARD-UPLOAD-COMPANY-B-INDEPENDENCE: Company A verifying does not verify the evidence for Company B', async () => {
    const { service } = buildHarness(activeLinks());
    const toA = await service.uploadDocumentForGuardUser(770, { type: GuardDocumentType.SIA_LICENCE, ...metadata, expiryDate: future, companyId: companyA.id });
    const toB = await service.uploadDocumentForGuardUser(770, { type: GuardDocumentType.SIA_LICENCE, ...metadata, expiryDate: future, companyId: companyB.id });
    notEqualIds(toA.id, toB.id);
    await service.completeDocumentUpload(user(770, UserRole.GUARD), toA.id);
    await service.completeDocumentUpload(user(770, UserRole.GUARD), toB.id);

    await service.verifyDocumentForCompanyUser(101, UserRole.COMPANY_ADMIN, toA.id, true);
    // Company B cannot verify (or even see) Company A's copy.
    await expectDenied(() => service.verifyDocumentForCompanyUser(201, UserRole.COMPANY_ADMIN, toA.id, true), 'notfound');

    const summaryA = await service.getGuardSummary(guard.id, companyA.id);
    const summaryB = await service.getGuardSummary(guard.id, companyB.id);
    ok(!summaryA.blockingReasons.includes('SIA licence document is not verified'), 'Company A accepted its own copy');
    ok(summaryB.blockingReasons.includes('SIA licence document is not verified'), 'Company B has NOT accepted its copy');
    equal(summaryA.documents.length, 1);
    equal(summaryB.documents.length, 1);
    equal(summaryA.documents[0].verified, true);
    equal(summaryB.documents[0].verified, false);
  });

  await test('GUARD-UPLOAD-COMPANY-REQUIRED: guard upload never guesses a company (even with one link)', async () => {
    const one = buildHarness(activeLinks([companyA]));
    await rejects(() => one.service.uploadDocumentForGuardUser(770, { type: GuardDocumentType.SIA_LICENCE, ...metadata }), BadRequestException);
    const none = buildHarness([]);
    await rejects(() => none.service.uploadDocumentForGuardUser(770, { type: GuardDocumentType.SIA_LICENCE, ...metadata }), BadRequestException);
    equal(one.documents.length + none.documents.length, 0);
  });

  await test('GUARD-UPLOAD-COMPANY-UNLINKED: guard cannot submit to a company it has no relationship or pre-hire application with', async () => {
    const { service, documents } = buildHarness(activeLinks());
    await expectDenied(() => service.uploadDocumentForGuardUser(770, { type: GuardDocumentType.SIA_LICENCE, ...metadata, companyId: companyC.id }));
    equal(documents.length, 0);
    const inactive = buildHarness([{ id: 9, guard, company: companyA, status: 'INACTIVE' }]);
    await expectDenied(() => inactive.service.uploadDocumentForGuardUser(770, { type: GuardDocumentType.SIA_LICENCE, ...metadata, companyId: companyA.id }));
    const blocked = buildHarness([{ id: 9, guard, company: companyA, status: 'BLOCKED' }]);
    await expectDenied(() => blocked.service.uploadDocumentForGuardUser(770, { type: GuardDocumentType.SIA_LICENCE, ...metadata, companyId: companyA.id }));
  });

  await test('GUARD-UPLOAD-PREHIRE: an eligible pre-hire application authorises submission to that company', async () => {
    const { service, documents } = buildHarness([], [companyC.id]);
    const uploaded = await service.uploadDocumentForGuardUser(770, { type: GuardDocumentType.RIGHT_TO_WORK, ...metadata, companyId: companyC.id });
    equal(uploaded.company!.id, companyC.id);
    equal(documents.length, 1);
  });

  await test('GUARD-UPLOAD-COMPANIES: guard lists only ACTIVE-linked companies', async () => {
    const { service } = buildHarness([
      ...activeLinks(),
      { id: 8, guard, company: companyC, status: 'BLOCKED' },
    ]);
    deepEqual(await service.listUploadCompaniesForGuardUser(770), [
      { companyId: companyA.id, name: companyA.name },
      { companyId: companyB.id, name: companyB.name },
    ]);
  });

  // ---- SCREENING OUTCOME ----------------------------------------------------------------------
  const outcomeCalls: Array<{ companyId: number; guardId: number }> = [];
  const controller = new ScreeningController(
    { companyOutcome: async (companyId: number, guardId: number) => (outcomeCalls.push({ companyId, guardId }), { guardId, status: ScreeningStatus.VETTED, vetted: true }) } as any,
    membership as any,
  );

  await test('SCREENING-OUTCOME-MEMBERSHIP: company comes from the authenticated membership, never the client', async () => {
    outcomeCalls.length = 0;
    const result = await controller.outcome(user(103, UserRole.COMPANY_STAFF), guard.id);
    deepEqual(Object.keys(result).sort(), ['guardId', 'status', 'vetted']);
    deepEqual(outcomeCalls, [{ companyId: companyA.id, guardId: guard.id }]);
    // A non-member (no membership row, not a legacy owner) is rejected before the service runs.
    outcomeCalls.length = 0;
    await expectDenied(() => controller.outcome(user(999, UserRole.COMPANY_STAFF), guard.id), 'notfound');
    equal(outcomeCalls.length, 0);
  });

  await test('SCREENING-OUTCOME-PERMISSION: screening.view is enforced from the role matrix', async () => {
    outcomeCalls.length = 0;
    for (const id of [101, 102, 103, 104]) await controller.outcome(user(id, UserRole.COMPANY_STAFF), guard.id); // owner, admin, HR, operations
    equal(outcomeCalls.length, 4);
    outcomeCalls.length = 0;
    for (const id of [105, 106, 107]) await expectDenied(() => controller.outcome(user(id, UserRole.COMPANY_STAFF), guard.id)); // control room, viewer, finance
    equal(outcomeCalls.length, 0);
  });

  await test('SCREENING-OUTCOME-TENANT: outcome requires an ACTIVE relationship with the resolved company and stays minimal', async () => {
    const seen: any[] = [];
    const fake: any = {
      companyGuards: { findOne: async ({ where }: any) => (seen.push(where), where.company.id === companyA.id && where.guard.id === guard.id ? { id: 1 } : null) },
      screenings: { findOne: async () => ({ status: ScreeningStatus.VETTED, reviewNotes: 'never leak', dateOfBirth: '1990-01-01' }) },
    };
    const outcome = await ScreeningService.prototype.companyOutcome.call(fake, companyA.id, guard.id);
    deepEqual(outcome, { guardId: guard.id, status: ScreeningStatus.VETTED, vetted: true });
    equal(seen[0].status, 'ACTIVE');
    await rejects(() => ScreeningService.prototype.companyOutcome.call(fake, companyB.id, guard.id), ForbiddenException);
    const notStarted = await ScreeningService.prototype.companyOutcome.call({ ...fake, screenings: { findOne: async () => null } }, companyA.id, guard.id);
    deepEqual(notStarted, { guardId: guard.id, status: ScreeningStatus.NOT_STARTED, vetted: false });
  });

  // ---- Batch outcomes (2D3.2): one request for the whole workspace, no N+1 -----------------------
  const batchCalls: number[] = [];
  const batchController = new ScreeningController(
    { companyOutcomes: async (companyId: number) => (batchCalls.push(companyId), [{ guardId: 1, status: ScreeningStatus.VETTED, vetted: true }]) } as any,
    membership as any,
  );

  await test('SCREENING-BATCH-PERMISSION: screening.view enforced; company from membership; denied roles never reach the service', async () => {
    batchCalls.length = 0;
    for (const id of [101, 102, 103, 104]) deepEqual(await batchController.outcomes(user(id, UserRole.COMPANY_STAFF)), [{ guardId: 1, status: ScreeningStatus.VETTED, vetted: true }]);
    deepEqual(batchCalls, [companyA.id, companyA.id, companyA.id, companyA.id]);
    batchCalls.length = 0;
    for (const id of [105, 106, 107]) await expectDenied(() => batchController.outcomes(user(id, UserRole.COMPANY_STAFF)));
    await expectDenied(() => batchController.outcomes(user(999, UserRole.COMPANY_STAFF)), 'notfound');
    equal(batchCalls.length, 0);
  });

  await test('SCREENING-BATCH-PROJECTION: minimal, tenant scoped, NOT_STARTED default, exactly two queries for any number of Guards', async () => {
    const guardsOfA = [10, 11, 12, 13];
    let linkQueries = 0;
    let screeningQueries = 0;
    let linkWhere: any;
    let screeningWhere: any;
    const fake: any = {
      companyGuards: {
        find: async ({ where }: any) => {
          linkQueries += 1; linkWhere = where;
          return where.company.id === companyA.id ? guardsOfA.map((id) => ({ id, guard: { id } })) : [{ id: 99, guard: { id: 50 } }];
        },
      },
      screenings: {
        find: async ({ where, select }: any) => {
          screeningQueries += 1; screeningWhere = where;
          ok(select && !('reviewNotes' in select) && !('dateOfBirth' in select), 'only id/status/guard.id are selected');
          return [
            { id: 1, status: ScreeningStatus.VETTED, guard: { id: 10 }, reviewNotes: 'never leak', dateOfBirth: '1990-01-01' },
            { id: 2, status: ScreeningStatus.REQUIRES_ATTENTION, guard: { id: 11 } },
            { id: 3, status: ScreeningStatus.IN_PROGRESS, guard: { id: 12 } },
          ];
        },
      },
    };
    const outcomes = await ScreeningService.prototype.companyOutcomes.call(fake, companyA.id);
    deepEqual(outcomes, [
      { guardId: 10, status: ScreeningStatus.VETTED, vetted: true },
      { guardId: 11, status: ScreeningStatus.REQUIRES_ATTENTION, vetted: false },
      { guardId: 12, status: ScreeningStatus.IN_PROGRESS, vetted: false },
      { guardId: 13, status: ScreeningStatus.NOT_STARTED, vetted: false },
    ]);
    equal(linkQueries, 1);
    equal(screeningQueries, 1, 'no per-Guard query');
    equal(linkWhere.company.id, companyA.id, 'scoped to the resolved company');
    ok(!JSON.stringify(outcomes).includes('never leak') && !JSON.stringify(outcomes).includes('1990'));
    for (const outcome of outcomes) deepEqual(Object.keys(outcome).sort(), ['guardId', 'status', 'vetted']);
    ok(screeningWhere.guard.id, 'screening lookup constrained to the Company\'s Guard ids');
    // Another company sees only its own Guards; a company with no Guards short-circuits with no screening query.
    const other = await ScreeningService.prototype.companyOutcomes.call(fake, companyB.id);
    deepEqual(other.map((row: any) => row.guardId), [50]);
    const empty: any = { companyGuards: { find: async () => [] }, screenings: { find: async () => { throw new Error('must not query'); } } };
    deepEqual(await ScreeningService.prototype.companyOutcomes.call(empty, companyA.id), []);
  });

  // ---- Negative control: the pre-2D3.1 rule (compliance.view) really would have leaked evidence ---
  await test('NEGATIVE-CONTROL: under the old compliance.view rule a viewer WOULD have received evidence', async () => {
    const legacyMembership = { resolveCompanyContext: async (userId: number, role: UserRole) => membership.resolveCompanyContext(userId, role, CompanyPermission.COMPLIANCE_VIEW) };
    ok(hasPermission(CompanyMembershipRole.VIEWER, CompanyPermission.COMPLIANCE_VIEW));
    const resolved = await legacyMembership.resolveCompanyContext(106, UserRole.COMPANY_STAFF);
    equal(resolved.company.id, companyA.id);
  });

  console.log(JSON.stringify({ event: 'compliance_evidence_hardening_tests_passed', tests: count }));
}

function notEqualIds(a: number, b: number) {
  ok(a !== b, 'each company receives its own evidence record');
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
