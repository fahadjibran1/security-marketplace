import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { CompanyMembershipRole, CompanyPermission, ROLE_PERMISSIONS, hasPermission } from '../src/company-membership/company-membership-types';
import { ComplianceController } from '../src/compliance/compliance.controller';
import { ComplianceService } from '../src/compliance/compliance.service';
import { ComplianceRecordType } from '../src/compliance/entities/compliance-record.entity';
import { GuardDocumentType } from '../src/compliance/entities/guard-document.entity';
import { GuardComplianceService } from '../src/compliance/guard-compliance.service';
import { PreHireComplianceAuthorizationService } from '../src/compliance/pre-hire-compliance-authorization.service';
import { UserRole, UserStatus } from '../src/user/entities/user.entity';

// 2D3.1B — Company compliance mutation authority is CompanyPermission.COMPLIANCE_MANAGE, enforced in the
// service through the membership permission model, and every write is tenant/Guard scoped.
// The membership mock enforces the REAL ROLE_PERMISSIONS matrix (nothing is hard-coded per role here).

const companyA = { id: 11, name: 'Company A' };
const companyB = { id: 22, name: 'Company B' };
const future = '2035-12-31';
const metadata = { originalFileName: 'evidence.pdf', mimeType: 'application/pdf', sizeBytes: 2048 };
const user = (sub: number, role: UserRole) => ({ sub, role, email: `${sub}@test`, status: UserStatus.ACTIVE });

const mkGuard = (id: number) => ({
  id, fullName: `Guard ${id}`, user: { id: id * 10 },
  siaLicenseNumber: '1234567890123456', siaExpiryDate: future, rightToWorkStatus: 'permanent', rightToWorkExpiryDate: null,
});
const guards: Record<number, ReturnType<typeof mkGuard>> = { 1: mkGuard(1), 2: mkGuard(2), 3: mkGuard(3), 4: mkGuard(4), 5: mkGuard(5) };
// 1: linked to A.  2: linked to B only.  3: eligible pre-hire for A (under_review, open job).  4: unrelated.
// 5: pre-hire application for A that is NOT eligible (rejected).  999: does not exist.

const ROLE_USERS: Array<{ id: number; role: CompanyMembershipRole; allowed: boolean }> = [
  { id: 101, role: CompanyMembershipRole.OWNER, allowed: true },
  { id: 102, role: CompanyMembershipRole.ADMIN, allowed: true },
  { id: 103, role: CompanyMembershipRole.HR_COMPLIANCE, allowed: true },
  { id: 104, role: CompanyMembershipRole.OPERATIONS, allowed: false },
  { id: 105, role: CompanyMembershipRole.CONTROL_ROOM, allowed: false },
  { id: 106, role: CompanyMembershipRole.FINANCE, allowed: false },
  { id: 107, role: CompanyMembershipRole.VIEWER, allowed: false },
];
const memberships: Record<number, { company: { id: number; name: string }; role: CompanyMembershipRole }> = {
  201: { company: companyB, role: CompanyMembershipRole.OWNER },
};
for (const entry of ROLE_USERS) memberships[entry.id] = { company: companyA, role: entry.role };

const membership = {
  resolveCompanyContext: async (userId: number, _role: UserRole, permission?: CompanyPermission) => {
    const found = memberships[userId];
    if (!found) throw new NotFoundException('Company not found.');
    if (permission && !hasPermission(found.role, permission)) throw new ForbiddenException('Insufficient permissions.');
    return { company: found.company, membershipRole: found.role };
  },
};

type Link = { id: number; guard: { id: number }; company: { id: number }; status: string };
type Application = { guard: { id: number }; job: { company: { id: number }; status: string }; status: string };

function buildHarness() {
  const documents: any[] = [];
  const records: any[] = [];
  const audits: any[] = [];
  let nextDocId = 1;
  let nextRecordId = 1;
  const links: Link[] = [
    { id: 1, guard: { id: 1 }, company: companyA, status: 'ACTIVE' },
    { id: 2, guard: { id: 2 }, company: companyB, status: 'ACTIVE' },
  ];
  const applications: Application[] = [
    { guard: { id: 3 }, job: { company: companyA, status: 'open' }, status: 'under_review' },
    { guard: { id: 5 }, job: { company: companyA, status: 'open' }, status: 'rejected' },
  ];
  const documentRepo = {
    create: (value: any) => ({ id: nextDocId++, uploadedAt: new Date(), ...value }),
    save: async (value: any) => {
      const index = documents.findIndex((item) => item.id === value.id);
      if (index >= 0) documents[index] = value; else documents.push(value);
      return value;
    },
    find: async ({ where }: any) => documents.filter((document) =>
      (!where.company || document.company?.id === where.company.id) && (!where.guard || document.guard.id === where.guard.id)),
    findOne: async ({ where }: any) => documents.find((document) =>
      document.id === where.id &&
      (!where.company || document.company?.id === where.company.id) &&
      (!where.guard || document.guard.id === where.guard.id)) ?? null,
  };
  const complianceRepo = {
    create: (value: any) => ({ id: nextRecordId++, ...value }),
    save: async (value: any) => {
      const index = records.findIndex((item) => item.id === value.id);
      if (index >= 0) records[index] = value; else records.push(value);
      return value;
    },
    find: async ({ where }: any) => records.filter((record) =>
      (!where.company || record.company.id === where.company.id) && (!where.guard || record.guard.id === where.guard.id)),
    findOne: async ({ where }: any) => records.find((record) =>
      record.company.id === where.company.id && record.guard.id === where.guard.id && record.type === where.type) ?? null,
  };
  const companyGuardRepo = {
    find: async ({ where }: any) => links.filter((link) =>
      (!where.company || link.company.id === where.company.id) && (!where.guard || link.guard.id === where.guard.id) &&
      (!where.status || link.status === where.status)),
  };
  const preHire = new PreHireComplianceAuthorizationService({
    findOne: async ({ where }: any) => applications.find((candidate) =>
      candidate.guard.id === where.guard.id && candidate.job.company.id === where.job.company.id &&
      candidate.job.status === where.job.status && candidate.status === where.status) ?? null,
  } as any);
  const storage = {
    provider: 's3-compatible',
    createSignedUploadUrl: async ({ key }: any) => ({ url: `https://objects.example/${key}?signature=upload`, expiresAt: new Date(Date.now() + 180000).toISOString(), method: 'PUT', headers: {} }),
    createSignedDownloadUrl: async ({ key }: any) => ({ url: `https://objects.example/${key}?signature=download`, expiresAt: new Date(Date.now() + 180000).toISOString(), method: 'GET' }),
    verifyUpload: async () => undefined,
  };
  const guardProfileService = {
    findOne: async (id: number) => { if (!guards[id]) throw new NotFoundException('Guard profile not found'); return guards[id]; },
    findByUserId: async () => null,
  };
  const guardCompliance = new GuardComplianceService(
    documentRepo as any, complianceRepo as any, companyGuardRepo as any, membership as any, guardProfileService as any,
    {} as any, { log: async (entry: any) => (audits.push(entry), entry) } as any, preHire as any, storage as any,
  );
  const compliance = new ComplianceService(complianceRepo as any, membership as any, guardProfileService as any, {} as any, guardCompliance);
  return { compliance, guardCompliance, documents, records, audits, links };
}

const recordDto = (guardId: number, over: Record<string, unknown> = {}) => ({
  guardId, type: ComplianceRecordType.SIA, documentName: 'SIA licence', documentNumber: '1234', issueDate: '2030-01-01', expiryDate: future, ...over,
}) as any;
const docDto = (guardId: number) => ({ guardId, type: GuardDocumentType.SIA_LICENCE, ...metadata, expiryDate: future }) as any;

async function expectError(work: () => Promise<unknown>, type: new (...args: any[]) => Error, message?: RegExp) {
  let error: unknown;
  try { await work(); } catch (caught) { error = caught; }
  ok(error instanceof type, `expected ${type.name}, got ${String(error)}`);
  if (message) ok(message.test((error as Error).message), `message ${(error as Error).message}`);
  return error as Error;
}

let count = 0;
async function test(name: string, work: () => Promise<void>) {
  await work();
  count += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  // ---- The canonical matrix -------------------------------------------------------------------
  await test('MATRIX: COMPLIANCE_MANAGE is held by exactly OWNER, ADMIN and HR_COMPLIANCE', async () => {
    const holders = Object.values(CompanyMembershipRole).filter((role) => ROLE_PERMISSIONS[role].has(CompanyPermission.COMPLIANCE_MANAGE)).sort();
    deepEqual(holders, [CompanyMembershipRole.ADMIN, CompanyMembershipRole.HR_COMPLIANCE, CompanyMembershipRole.OWNER].sort());
    for (const entry of ROLE_USERS) equal(hasPermission(entry.role, CompanyPermission.COMPLIANCE_MANAGE), entry.allowed, `${entry.role}`);
  });

  // ---- Controller entry gates -----------------------------------------------------------------
  await test('CONTROLLER: company mutation routes admit company_staff at entry; Guard-owned /mine routes are untouched', async () => {
    const proto: any = ComplianceController.prototype;
    const roles = (handler: string): UserRole[] => Reflect.getMetadata(ROLES_KEY, proto[handler]);
    for (const handler of ['uploadForCompany', 'verifyDocument', 'create', 'update']) {
      const allowed = roles(handler);
      ok(allowed.includes(UserRole.COMPANY_STAFF), `${handler} must admit company_staff (HR_COMPLIANCE) at entry`);
      ok(allowed.includes(UserRole.COMPANY) && allowed.includes(UserRole.COMPANY_ADMIN), `${handler} still admits owners`);
      ok(!allowed.includes(UserRole.GUARD) && !allowed.includes(UserRole.CLIENT_ADMIN) && !allowed.includes(UserRole.CLIENT_VIEWER), `${handler} stays closed to guards and client users`);
    }
    const complete = roles('completeDocumentUpload');
    ok(complete.includes(UserRole.COMPANY_STAFF) && complete.includes(UserRole.GUARD) && complete.includes(UserRole.ADMIN));
    ok(!complete.includes(UserRole.CLIENT_ADMIN));
    deepEqual(roles('uploadMine'), [UserRole.GUARD]);
    deepEqual(roles('listMyUploadCompanies'), [UserRole.GUARD]);
    deepEqual(roles('listMyDocuments'), [UserRole.GUARD]);
  });

  // ---- Role matrix per mutation class ---------------------------------------------------------
  await test('RECORD SAVE: manager roles allowed (create then update); every other role denied with no write', async () => {
    for (const entry of ROLE_USERS) {
      const { compliance, records } = buildHarness();
      if (entry.allowed) {
        const created = await compliance.upsertForCompanyUser(entry.id, UserRole.COMPANY_STAFF, recordDto(1));
        equal(created.company.id, companyA.id);
        const updated = await compliance.upsertForCompanyUser(entry.id, UserRole.COMPANY_STAFF, recordDto(1, { expiryDate: '2036-06-30' }));
        equal(updated.id, created.id, 'second save updates the same record');
        equal(records.length, 1);
        equal(records[0].expiryDate, '2036-06-30');
      } else {
        await expectError(() => compliance.upsertForCompanyUser(entry.id, UserRole.COMPANY_STAFF, recordDto(1)), ForbiddenException, /Insufficient permissions/);
        equal(records.length, 0, `${entry.role} must not write`);
      }
    }
  });

  await test('DOCUMENT UPLOAD: manager roles allowed; every other role denied with no document created', async () => {
    for (const entry of ROLE_USERS) {
      const { guardCompliance, documents } = buildHarness();
      if (entry.allowed) {
        const uploaded = await guardCompliance.uploadDocumentForCompanyUser(entry.id, UserRole.COMPANY_STAFF, docDto(1));
        equal(uploaded.company!.id, companyA.id);
        equal(uploaded.uploadedByUserId, entry.id);
        equal(documents.length, 1);
      } else {
        await expectError(() => guardCompliance.uploadDocumentForCompanyUser(entry.id, UserRole.COMPANY_STAFF, docDto(1)), ForbiddenException, /Insufficient permissions/);
        equal(documents.length, 0, `${entry.role} must not upload`);
      }
    }
  });

  await test('UPLOAD COMPLETION: manager roles allowed; every other role denied and the document stays incomplete', async () => {
    for (const entry of ROLE_USERS) {
      const { guardCompliance, documents } = buildHarness();
      const uploaded = await guardCompliance.uploadDocumentForCompanyUser(101, UserRole.COMPANY_ADMIN, docDto(1));
      equal(uploaded.uploadCompletedAt, null);
      if (entry.allowed) {
        const done = await guardCompliance.completeDocumentUpload(user(entry.id, UserRole.COMPANY_STAFF), uploaded.id);
        ok(done.uploadCompletedAt instanceof Date);
      } else {
        await expectError(() => guardCompliance.completeDocumentUpload(user(entry.id, UserRole.COMPANY_STAFF), uploaded.id), ForbiddenException, /Insufficient permissions/);
        equal(documents[0].uploadCompletedAt ?? null, null, `${entry.role} must not complete an upload`);
      }
    }
  });

  await test('VERIFY / UNVERIFY: manager roles allowed and recorded; every other role denied with state unchanged', async () => {
    for (const entry of ROLE_USERS) {
      const { guardCompliance, documents, audits } = buildHarness();
      const uploaded = await guardCompliance.uploadDocumentForCompanyUser(101, UserRole.COMPANY_ADMIN, docDto(1));
      await guardCompliance.completeDocumentUpload(user(101, UserRole.COMPANY_ADMIN), uploaded.id);
      if (entry.allowed) {
        const verified = await guardCompliance.verifyDocumentForCompanyUser(entry.id, UserRole.COMPANY_STAFF, uploaded.id, true);
        equal(verified.verified, true);
        equal(verified.verifiedByUserId, entry.id);
        const unverified = await guardCompliance.verifyDocumentForCompanyUser(entry.id, UserRole.COMPANY_STAFF, uploaded.id, false);
        equal(unverified.verified, false);
        equal(audits.filter((audit) => audit.action === 'guard_document.verified').length, 2);
      } else {
        await expectError(() => guardCompliance.verifyDocumentForCompanyUser(entry.id, UserRole.COMPANY_STAFF, uploaded.id, true), ForbiddenException, /Insufficient permissions/);
        equal(documents[0].verified, false);
        equal(documents[0].verifiedByUserId ?? null, null);
        equal(audits.filter((audit) => audit.action === 'guard_document.verified').length, 0);
        // Unverify is the same mutation: denied too, even for a document another manager verified.
        await guardCompliance.verifyDocumentForCompanyUser(101, UserRole.COMPANY_ADMIN, uploaded.id, true);
        await expectError(() => guardCompliance.verifyDocumentForCompanyUser(entry.id, UserRole.COMPANY_STAFF, uploaded.id, false), ForbiddenException);
        equal(documents[0].verified, true, `${entry.role} must not unverify`);
      }
    }
  });

  await test('EVIDENCE ACCESS unchanged: file access needs COMPLIANCE_MANAGE; status/list stays on COMPLIANCE_VIEW', async () => {
    const { guardCompliance } = buildHarness();
    const uploaded = await guardCompliance.uploadDocumentForCompanyUser(101, UserRole.COMPANY_ADMIN, docDto(1));
    await guardCompliance.completeDocumentUpload(user(101, UserRole.COMPANY_ADMIN), uploaded.id);
    for (const entry of ROLE_USERS) {
      if (entry.allowed) {
        equal((await guardCompliance.createDocumentAccess(user(entry.id, UserRole.COMPANY_STAFF), uploaded.id)).method, 'GET');
      } else {
        await expectError(() => guardCompliance.createDocumentAccess(user(entry.id, UserRole.COMPANY_STAFF), uploaded.id), ForbiddenException);
      }
      const viewPermitted = hasPermission(entry.role, CompanyPermission.COMPLIANCE_VIEW);
      if (viewPermitted) equal((await guardCompliance.listDocumentsForCompanyUser(entry.id, UserRole.COMPANY_STAFF, 1)).length, 1);
      else await expectError(() => guardCompliance.listDocumentsForCompanyUser(entry.id, UserRole.COMPANY_STAFF, 1), ForbiddenException);
    }
  });

  // ---- Record save: Guard ownership -----------------------------------------------------------
  await test('RECORD-LINKED-GUARD: a Guard linked to the Company is allowed', async () => {
    const { compliance, records } = buildHarness();
    const saved = await compliance.upsertForCompanyUser(101, UserRole.COMPANY_ADMIN, recordDto(1));
    equal(saved.guard.id, 1);
    equal(records.length, 1);
  });

  await test('RECORD-PREHIRE-GUARD: a Guard with an eligible under_review application is allowed (certified pre-hire path preserved)', async () => {
    const { compliance, records } = buildHarness();
    const saved = await compliance.upsertForCompanyUser(101, UserRole.COMPANY_ADMIN, recordDto(3));
    equal(saved.guard.id, 3);
    equal(saved.company.id, companyA.id);
    equal(records.length, 1);
  });

  await test('RECORD-UNRELATED-GUARD: unrelated, other-company-only, ineligible pre-hire and non-existent Guards all get the same 403', async () => {
    const { compliance, records } = buildHarness();
    const messages = new Set<string>();
    for (const guardId of [4, 2, 5, 999]) {
      const error = await expectError(() => compliance.upsertForCompanyUser(101, UserRole.COMPANY_ADMIN, recordDto(guardId)), ForbiddenException);
      messages.add(error.message);
    }
    equal(messages.size, 1, 'no response difference that would let Guard ids be enumerated');
    equal(records.length, 0);
  });

  await test('RECORD-TENANT: Company A cannot create or update compliance for a Guard linked only to Company B', async () => {
    const { compliance, records } = buildHarness();
    await compliance.upsertForCompanyUser(201, UserRole.COMPANY_ADMIN, recordDto(2, { expiryDate: '2031-01-01' }));
    equal(records.length, 1);
    await expectError(() => compliance.upsertForCompanyUser(101, UserRole.COMPANY_ADMIN, recordDto(2)), ForbiddenException);
    equal(records.length, 1, 'no record created for Company A');
    equal(records[0].company.id, companyB.id);
    equal(records[0].expiryDate, '2031-01-01', "Company B's record is untouched");
    // And Company A's own record for a shared Guard never overwrites B's.
    const b = buildHarness();
    b.links.push({ id: 3, guard: { id: 1 }, company: companyB, status: 'ACTIVE' });
    const recA = await b.compliance.upsertForCompanyUser(101, UserRole.COMPANY_ADMIN, recordDto(1, { expiryDate: '2031-01-01' }));
    const recB = await b.compliance.upsertForCompanyUser(201, UserRole.COMPANY_ADMIN, recordDto(1, { expiryDate: '2032-02-02' }));
    ok(recA.id !== recB.id);
    equal(b.records.find((record) => record.company.id === companyA.id).expiryDate, '2031-01-01');
  });

  await test('RECORD-BODY-COMPANY-IGNORED: a companyId smuggled in the body cannot redirect the write', async () => {
    const { compliance, records } = buildHarness();
    await compliance.upsertForCompanyUser(101, UserRole.COMPANY_ADMIN, recordDto(1, { companyId: companyB.id, company: companyB }));
    equal(records[0].company.id, companyA.id);
    await expectError(() => compliance.upsertForCompanyUser(101, UserRole.COMPANY_ADMIN, recordDto(2, { companyId: companyB.id })), ForbiddenException);
  });

  await test('RECORD-ORDER: permission is checked before Guard ownership (no Guard-existence oracle for non-managers)', async () => {
    const { compliance } = buildHarness();
    const forUnrelated = await expectError(() => compliance.upsertForCompanyUser(107, UserRole.COMPANY_STAFF, recordDto(4)), ForbiddenException);
    const forLinked = await expectError(() => compliance.upsertForCompanyUser(107, UserRole.COMPANY_STAFF, recordDto(1)), ForbiddenException);
    equal(forUnrelated.message, forLinked.message);
    equal(forUnrelated.message, 'Insufficient permissions.');
  });

  // ---- Document mutations: tenant ------------------------------------------------------------
  await test('UPLOAD-TENANT: Company A cannot upload for a Guard linked only to Company B, nor an unrelated/non-existent Guard', async () => {
    const { guardCompliance, documents } = buildHarness();
    const messages = new Set<string>();
    for (const guardId of [2, 4, 5, 999]) {
      messages.add((await expectError(() => guardCompliance.uploadDocumentForCompanyUser(101, UserRole.COMPANY_ADMIN, docDto(guardId)), ForbiddenException)).message);
    }
    equal(messages.size, 1);
    equal(documents.length, 0);
    const preHire = await guardCompliance.uploadDocumentForCompanyUser(101, UserRole.COMPANY_ADMIN, docDto(3));
    equal(preHire.guard.id, 3, 'pre-hire upload still works');
  });

  await test('VERIFY-TENANT + COMPLETE-TENANT: Company A cannot verify or complete Company B documents (404)', async () => {
    const { guardCompliance, documents } = buildHarness();
    const bDoc = await guardCompliance.uploadDocumentForCompanyUser(201, UserRole.COMPANY_ADMIN, docDto(2));
    await expectError(() => guardCompliance.completeDocumentUpload(user(101, UserRole.COMPANY_ADMIN), bDoc.id), NotFoundException);
    equal(documents[0].uploadCompletedAt ?? null, null);
    await guardCompliance.completeDocumentUpload(user(201, UserRole.COMPANY_ADMIN), bDoc.id);
    await expectError(() => guardCompliance.verifyDocumentForCompanyUser(101, UserRole.COMPANY_ADMIN, bDoc.id, true), NotFoundException);
    await expectError(() => guardCompliance.verifyDocumentForCompanyUser(102, UserRole.COMPANY_STAFF, bDoc.id, true), NotFoundException);
    equal(documents[0].verified, false);
    await expectError(() => guardCompliance.verifyDocumentForCompanyUser(101, UserRole.COMPANY_ADMIN, 99999, true), NotFoundException);
  });

  // ---- Negative control ----------------------------------------------------------------------
  await test('NEGATIVE-CONTROL: without the ownership check Company A WOULD have written a record for a Company-B-only Guard', async () => {
    const { records, guardCompliance } = buildHarness();
    const legacyGuardCompliance: any = Object.create(guardCompliance);
    legacyGuardCompliance.authorizeGuardForCompanyMutation = async (_companyId: number, guardId: number) => guardId;
    const legacy = new ComplianceService(
      { create: (value: any) => ({ id: 1, ...value }), save: async (value: any) => (records.push(value), value), findOne: async () => null } as any,
      membership as any,
      { findOne: async (id: number) => guards[id] } as any,
      {} as any, legacyGuardCompliance,
    );
    await legacy.upsertForCompanyUser(101, UserRole.COMPANY_ADMIN, recordDto(2));
    equal(records.length, 1, 'legacy behaviour reproduced: cross-tenant write accepted');
    equal(records[0].company.id, companyA.id);
    equal(records[0].guard.id, 2);
  });

  console.log(JSON.stringify({ event: 'compliance_authorization_tests_passed', tests: count }));
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
