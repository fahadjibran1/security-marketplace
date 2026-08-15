import { equal, ok } from 'node:assert/strict';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { CompanyGuardService } from '../src/company-guard/company-guard.service';
import { GuardComplianceService } from '../src/compliance/guard-compliance.service';
import { GuardDocumentType } from '../src/compliance/entities/guard-document.entity';
import { GuardProfileService } from '../src/guard-profile/guard-profile.service';
import { UserRole, UserStatus } from '../src/user/entities/user.entity';

const companyA = { id: 11 };
const companyB = { id: 22 };
const guard = { id: 33, user: { id: 330 }, status: 'pending', approvalStatus: 'pending', isApproved: false };

function companyForUser(userId: number) {
  return userId === 101 ? companyA : userId === 202 ? companyB : null;
}

function buildComplianceHarness(legacyAuthorization = false) {
  let nextId = 1;
  const documents: any[] = [];
  const audits: any[] = [];
  const documentRepo = {
    create: (value: any) => ({ id: nextId++, ...value }),
    save: async (value: any) => value,
    find: async ({ where }: any) => {
      const companyId = where.company?.id;
      const guardId = where.guard?.id;
      const guardIds = guardId?._value ?? guardId;
      return documents.filter((document) =>
        (!companyId || document.company?.id === companyId) &&
        (!guardIds || (Array.isArray(guardIds) ? guardIds.includes(document.guard.id) : document.guard.id === guardIds)),
      );
    },
    findOne: async ({ where }: any) => documents.find((document) =>
      document.id === where.id && (legacyAuthorization || !where.company || document.company?.id === where.company.id),
    ) ?? null,
  };
  documentRepo.save = async (value: any) => {
    const index = documents.findIndex((document) => document.id === value.id);
    if (index >= 0) documents[index] = value;
    else documents.push(value);
    return value;
  };
  const companyGuardRepo = {
    find: async ({ where }: any) => [{ id: 1, company: { id: where.company?.id }, guard, status: 'ACTIVE' }],
  };
  const service = new GuardComplianceService(
    documentRepo as any,
    { find: async () => [] } as any,
    companyGuardRepo as any,
    { findByUserId: async (id: number) => companyForUser(id) } as any,
    { findOne: async () => guard, findByUserId: async () => guard } as any,
    {} as any,
    { log: async (entry: any) => (audits.push(entry), entry) } as any,
    {} as any,
  );
  return { service, documents, audits };
}

async function expectForbidden(work: () => Promise<unknown>) {
  let error: unknown;
  try { await work(); } catch (caught) { error = caught; }
  ok(error instanceof ForbiddenException);
}

async function expectNotFound(work: () => Promise<unknown>) {
  let error: unknown;
  try { await work(); } catch (caught) { error = caught; }
  ok(error instanceof NotFoundException);
}

async function testGuessedGuardCannotCreateMembership() {
  const service = new CompanyGuardService({} as any, {} as any, {} as any);
  await expectForbidden(() => service.createForUser(
    { sub: 202, email: 'b@test', role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE },
    { companyId: companyA.id, guardId: guard.id },
  ));
}

async function testCompanyApprovalRequiresServerRelationship() {
  const service = new GuardProfileService(
    { findOne: async () => guard } as any,
    { findOne: async () => null } as any,
    {} as any,
    { findByUserId: async () => companyA } as any,
    {} as any,
  );
  await expectForbidden(() => service.approveForUser(
    { sub: 101, email: 'a@test', role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE },
    guard.id,
  ));
}

async function uploadFor(service: GuardComplianceService, userId: number, type: GuardDocumentType, url: string) {
  return service.uploadDocumentForCompanyUser(userId, { guardId: guard.id, type, fileUrl: url, expiryDate: '2027-12-31' });
}

async function testCompanyUploadHasExplicitOwnership() {
  const { service } = buildComplianceHarness();
  const document = await uploadFor(service, 101, GuardDocumentType.SIA_LICENCE, 'https://private/a-sia');
  equal(document.company!.id, companyA.id);
  equal(document.uploadedByUserId, 101);
}

async function testCompanyBCannotReadCompanyADocument() {
  const { service } = buildComplianceHarness();
  await uploadFor(service, 101, GuardDocumentType.SIA_LICENCE, 'https://private/a-sia');
  const visible = await service.listDocumentsForCompanyUser(202, guard.id);
  equal(visible.length, 0);
}

async function testCompanyBCannotVerifyCompanyADocument() {
  const { service, audits } = buildComplianceHarness();
  const document = await uploadFor(service, 101, GuardDocumentType.SIA_LICENCE, 'https://private/a-sia');
  await expectNotFound(() => service.verifyDocumentForCompanyUser(202, document.id, true));
  equal(audits.filter((entry) => entry.action === 'guard_document.verified').length, 0);
}

async function testCompanyAReadsAndVerifiesOwnDocument() {
  const { service } = buildComplianceHarness();
  const document = await uploadFor(service, 101, GuardDocumentType.SIA_LICENCE, 'https://private/a-sia');
  equal((await service.listDocumentsForCompanyUser(101, guard.id)).length, 1);
  const verified = await service.verifyDocumentForCompanyUser(101, document.id, true);
  equal(verified.verified, true);
  equal(verified.verifiedByUserId, 101);
  ok(verified.verifiedAt instanceof Date);
}

async function testGuardCanReadOwnDocuments() {
  const { service } = buildComplianceHarness();
  await uploadFor(service, 101, GuardDocumentType.SIA_LICENCE, 'https://private/a-sia');
  await uploadFor(service, 202, GuardDocumentType.RIGHT_TO_WORK, 'https://private/b-rtw');
  equal((await service.listDocumentsForGuardUser(330)).length, 2);
}

async function testSuccessfulAuditUsesOwningCompanyAndActor() {
  const { service, audits } = buildComplianceHarness();
  const document = await uploadFor(service, 101, GuardDocumentType.SIA_LICENCE, 'https://private/a-sia');
  await service.verifyDocumentForCompanyUser(101, document.id, true);
  const audit = audits.find((entry) => entry.action === 'guard_document.verified');
  equal(audit.company.id, companyA.id);
  equal(audit.user.id, 101);
  equal(audit.entityId, document.id);
}

async function testCrossTenantResponseCannotContainSensitiveUrl() {
  const { service } = buildComplianceHarness();
  await uploadFor(service, 101, GuardDocumentType.SIA_LICENCE, 'https://private/a-sia');
  const response = JSON.stringify(await service.listDocumentsForCompanyUser(202, guard.id));
  ok(!response.includes('https://private/a-sia'));
}

async function testMultiCompanyEvidenceRemainsIsolated() {
  const { service } = buildComplianceHarness();
  await uploadFor(service, 101, GuardDocumentType.SIA_LICENCE, 'https://private/a-sia');
  await uploadFor(service, 202, GuardDocumentType.SIA_LICENCE, 'https://private/b-sia');
  const a = await service.listDocumentsForCompanyUser(101, guard.id);
  const b = await service.listDocumentsForCompanyUser(202, guard.id);
  equal(a.length, 1);
  equal(b.length, 1);
  equal(a[0].company!.id, companyA.id);
  equal(b[0].company!.id, companyB.id);
}

async function proveNegativeControl() {
  const { service } = buildComplianceHarness(true);
  const document = await uploadFor(service, 101, GuardDocumentType.SIA_LICENCE, 'https://private/a-sia');
  const wronglyVerified = await service.verifyDocumentForCompanyUser(202, document.id, true);
  equal(wronglyVerified.verified, true, 'legacy authorization simulation must reproduce cross-tenant mutation');
}

async function main() {
  await testGuessedGuardCannotCreateMembership();
  await testCompanyApprovalRequiresServerRelationship();
  await testCompanyUploadHasExplicitOwnership();
  await testCompanyBCannotReadCompanyADocument();
  await testCompanyBCannotVerifyCompanyADocument();
  await testCompanyAReadsAndVerifiesOwnDocument();
  await testGuardCanReadOwnDocuments();
  await testSuccessfulAuditUsesOwningCompanyAndActor();
  await testCrossTenantResponseCannotContainSensitiveUrl();
  await testMultiCompanyEvidenceRemainsIsolated();
  await proveNegativeControl();
  console.log(JSON.stringify({
    event: 'compliance_tenant_isolation_tests_passed',
    tests: 10,
    negativeControl: 'legacy company-guard-only authorization allowed Company B to verify Company A document',
  }));
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
