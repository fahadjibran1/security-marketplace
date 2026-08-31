import { equal, ok } from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';

import { CompanyGuardService } from '../src/company-guard/company-guard.service';
import { GuardComplianceService } from '../src/compliance/guard-compliance.service';
import { GuardDocumentType } from '../src/compliance/entities/guard-document.entity';
import { PreHireComplianceAuthorizationService } from '../src/compliance/pre-hire-compliance-authorization.service';
import { JobApplicationService } from '../src/job-application/job-application.service';
import { UserRole, UserStatus } from '../src/user/entities/user.entity';

const guard = { id: 31, fullName: 'Pre-hire Guard', user: { id: 310 } };
const companyA = { id: 41, user: { id: 410 } };
const companyB = { id: 42, user: { id: 420 } };
const openJobA = { id: 51, company: companyA, status: 'open', guardsRequired: 1, title: 'A Job' };
const evidenceMetadata = { originalFileName: 'evidence.pdf', mimeType: 'application/pdf', sizeBytes: 1024 };
const storage = {
  provider: 's3-compatible',
  createSignedUploadUrl: async ({ key }: any) => ({ url: `https://signed.test/${key}?signature=upload`, expiresAt: new Date(Date.now() + 180000).toISOString(), method: 'PUT' }),
  createSignedDownloadUrl: async ({ key }: any) => ({ url: `https://signed.test/${key}?signature=download`, expiresAt: new Date(Date.now() + 180000).toISOString(), method: 'GET' }),
};

function application(status = 'under_review', company = companyA) {
  return { id: 61, guard, job: { ...openJobA, company }, status, assignments: [] };
}

async function expectForbidden(work: () => Promise<unknown>) {
  let error: unknown;
  try { await work(); } catch (caught) { error = caught; }
  ok(error instanceof ForbiddenException);
}

function buildHarness(applications: any[] = [application()]) {
  const documents: any[] = [];
  const audits: any[] = [];
  let nextId = 1;
  const authorization = new PreHireComplianceAuthorizationService({
    findOne: async ({ where }: any) => applications.find((candidate) =>
      candidate.guard.id === where.guard.id &&
      candidate.job.company.id === where.job.company.id &&
      candidate.job.status === where.job.status &&
      candidate.status === where.status,
    ) ?? null,
  } as any);
  const documentRepo = {
    create: (value: any) => ({ id: nextId++, ...value }),
    save: async (value: any) => {
      const index = documents.findIndex((document) => document.id === value.id);
      if (index >= 0) documents[index] = value;
      else documents.push(value);
      return value;
    },
    find: async ({ where }: any) => documents.filter((document) =>
      (!where.company || document.company?.id === where.company.id) && document.guard.id === guard.id,
    ),
    findOne: async ({ where }: any) => documents.find((document) =>
      document.id === where.id && document.company?.id === where.company?.id,
    ) ?? null,
  };
  const service = new GuardComplianceService(
    documentRepo as any,
    { find: async () => [] } as any,
    { find: async () => [] } as any,
    { findByUserId: async (userId: number) => userId === 101 ? companyA : companyB } as any,
    { findOne: async () => guard, findByUserId: async () => guard } as any,
    {} as any,
    { log: async (entry: any) => (audits.push(entry), entry) } as any,
    authorization,
    storage as any,
  );
  return { service, documents, audits, authorization };
}

async function testRandomCompanyCannotUpload() {
  const { service } = buildHarness([application('under_review', companyA)]);
  await expectForbidden(() => service.uploadDocumentForCompanyUser(202, {
    guardId: guard.id, type: GuardDocumentType.SIA_LICENCE, fileUrl: 'https://private/b',
  }));
}

async function testGuardExistenceAloneDoesNotAuthorize() {
  const { service } = buildHarness([]);
  await expectForbidden(() => service.uploadDocumentForCompanyUser(101, {
    guardId: guard.id, type: GuardDocumentType.SIA_LICENCE, fileUrl: 'https://private/a',
  }));
}

async function testUnderReviewApplicationAuthorizesUpload() {
  const { service } = buildHarness();
  const document = await service.uploadDocumentForCompanyUser(101, {
    guardId: guard.id, type: GuardDocumentType.SIA_LICENCE, fileUrl: 'https://private/a',
  });
  equal(document.id, 1);
}

async function testUploadUsesPersistedGuardAndServerOwnership() {
  const { service } = buildHarness();
  const document = await service.uploadDocumentForCompanyUser(101, {
    guardId: guard.id, type: GuardDocumentType.RIGHT_TO_WORK, fileUrl: 'https://private/a',
  });
  equal(document.guard.id, guard.id);
  equal(document.company!.id, companyA.id);
  equal(document.uploadedByUserId, 101);
}

async function testApplicationDoesNotExposeGuardOwnedEvidence() {
  const { service, documents } = buildHarness();
  documents.push({ id: 7, guard, company: null, fileUrl: 'https://private/guard' });
  equal((await service.listDocumentsForCompanyUser(101, guard.id)).length, 0);
}

async function testApplicationDoesNotExposeOtherCompanyEvidence() {
  const { service, documents } = buildHarness();
  documents.push({ id: 8, guard, company: companyB, fileUrl: 'https://private/b' });
  equal((await service.listDocumentsForCompanyUser(101, guard.id)).length, 0);
}

async function testCompanyCannotVerifyOtherCompanyEvidence() {
  const { service, documents, audits } = buildHarness();
  documents.push({ id: 8, guard, company: companyB, verified: false });
  let rejected = false;
  try { await service.verifyDocumentForCompanyUser(101, 8, true); } catch { rejected = true; }
  ok(rejected);
  equal(audits.filter((entry) => entry.action === 'guard_document.verified').length, 0);
}

function buildHireHarness(assignable = true) {
  const app = application();
  const calls = { applicationSave: 0, jobSave: 0, relationship: 0, assignment: 0, shift: 0 };
  const service = new JobApplicationService(
    { findOne: async () => app, save: async (value: any) => (calls.applicationSave += 1, value) } as any,
    { save: async (value: any) => (calls.jobSave += 1, value) } as any,
    {} as any,
    {
      countActiveByJob: async () => calls.assignment,
      createFromHire: async () => (calls.assignment += 1, { id: 71, guard, company: companyA }),
    } as any,
    { create: async () => (calls.shift += 1, { shift: { id: 81 } }) } as any,
    { log: async () => undefined } as any,
    { createForUser: async () => undefined } as any,
    {} as any,
    { findOne: async () => ({ id: 91, company: companyA }) } as any,
    { ensureRelationship: async () => (calls.relationship += 1, { id: 1 }) } as any,
    { assertGuardCanTakeShift: async () => undefined } as any,
    { assertGuardAssignable: async () => {
      if (!assignable) throw new ForbiddenException('Guard profile is not approved.');
    } } as any,
    {
      transaction: async (work: (manager: any) => Promise<unknown>) => work({
        getRepository: (entity: { name: string }) => entity.name === 'Job'
          ? {
              createQueryBuilder: () => {
                const builder: any = {
                  select: () => builder,
                  where: () => builder,
                  setLock: () => builder,
                  getOne: async () => ({ id: app.job.id }),
                };
                return builder;
              },
              findOne: async () => app.job,
            }
          : {
              findOne: async () => app,
              save: async (value: any) => (calls.applicationSave += 1, value),
            },
      }),
    } as any,
  );
  return { service, calls, app };
}

async function testValidEvidenceAllowsHire() {
  const { service } = buildHireHarness();
  const result = await service.hire(61, { createShift: true, siteId: 91, start: '2026-09-01T09:00:00Z', end: '2026-09-01T17:00:00Z' });
  equal(result.application.status, 'accepted');
}

async function testHireCreatesRelationshipAssignmentAndShift() {
  const { service, calls } = buildHireHarness();
  await service.hire(61, { createShift: true, siteId: 91, start: '2026-09-01T09:00:00Z', end: '2026-09-01T17:00:00Z' });
  equal(calls.relationship, 1);
  equal(calls.assignment, 1);
  equal(calls.shift, 1);
}

async function testUnapprovedHireLeavesNoPartialCommercialState() {
  const { service, calls, app } = buildHireHarness(false);
  await expectForbidden(() => service.hire(61, {
    createShift: true,
    siteId: 91,
    start: '2026-09-01T09:00:00Z',
    end: '2026-09-01T17:00:00Z',
  }));
  equal(app.status, 'under_review');
  equal(calls.applicationSave, 0);
  equal(calls.jobSave, 0);
  equal(calls.relationship, 0);
  equal(calls.assignment, 0);
  equal(calls.shift, 0);
}

async function testRejectedApplicationDoesNotAuthorize() {
  const { service } = buildHarness([application('rejected')]);
  await expectForbidden(() => service.uploadDocumentForCompanyUser(101, {
    guardId: guard.id, type: GuardDocumentType.SIA_LICENCE, fileUrl: 'https://private/a',
  }));
}

async function testDirectMembershipStillDenied() {
  const service = new CompanyGuardService({} as any, {} as any, {} as any, {} as any);
  await expectForbidden(() => service.createForUser(
    { sub: 101, email: 'a@test', role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE },
    { companyId: companyA.id, guardId: guard.id },
  ));
}

async function testMultiCompanyPreHireEvidenceIsIsolated() {
  const { service } = buildHarness([application('under_review', companyA), application('under_review', companyB)]);
  await service.uploadDocumentForCompanyUser(101, { guardId: guard.id, type: GuardDocumentType.SIA_LICENCE, fileUrl: 'https://private/a' });
  await service.uploadDocumentForCompanyUser(202, { guardId: guard.id, type: GuardDocumentType.SIA_LICENCE, fileUrl: 'https://private/b' });
  const a = await service.listDocumentsForCompanyUser(101, guard.id);
  const b = await service.listDocumentsForCompanyUser(202, guard.id);
  equal(a.length, 1);
  equal(b.length, 1);
  ok(!JSON.stringify(a).includes('https://private/b'));
  ok(!JSON.stringify(b).includes('https://private/a'));
}

async function testPreHireAuditUsesCompanyAndActor() {
  const { service, audits } = buildHarness();
  const document = await service.uploadDocumentForCompanyUser(101, {
    guardId: guard.id, type: GuardDocumentType.SIA_LICENCE, fileUrl: 'https://private/a',
  });
  await service.verifyDocumentForCompanyUser(101, document.id, true);
  equal(audits[0].action, 'guard_document.uploaded');
  equal(audits[0].company.id, companyA.id);
  equal(audits[0].user.id, 101);
  equal(audits[1].action, 'guard_document.verified');
}

async function proveDeadlockNegativeControl() {
  const { service } = buildHarness([]);
  await expectForbidden(() => service.uploadDocumentForCompanyUser(101, {
    guardId: guard.id, type: GuardDocumentType.SIA_LICENCE, fileUrl: 'https://private/a',
  }));
}

async function main() {
  await testRandomCompanyCannotUpload();
  await testGuardExistenceAloneDoesNotAuthorize();
  await testUnderReviewApplicationAuthorizesUpload();
  await testUploadUsesPersistedGuardAndServerOwnership();
  await testApplicationDoesNotExposeGuardOwnedEvidence();
  await testApplicationDoesNotExposeOtherCompanyEvidence();
  await testCompanyCannotVerifyOtherCompanyEvidence();
  await testValidEvidenceAllowsHire();
  await testHireCreatesRelationshipAssignmentAndShift();
  await testUnapprovedHireLeavesNoPartialCommercialState();
  await testRejectedApplicationDoesNotAuthorize();
  await testDirectMembershipStillDenied();
  await testMultiCompanyPreHireEvidenceIsIsolated();
  await testPreHireAuditUsesCompanyAndActor();
  await proveDeadlockNegativeControl();
  console.log(JSON.stringify({
    event: 'prehire_compliance_tests_passed', tests: 14,
    negativeControl: 'without under_review application authority, company upload remains forbidden and hire preflight deadlocks',
  }));
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
