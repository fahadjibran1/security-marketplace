import { equal, ok } from 'node:assert/strict';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { GuardComplianceService } from '../src/compliance/guard-compliance.service';
import { GuardDocumentType } from '../src/compliance/entities/guard-document.entity';
import { GuardApprovalStatus } from '../src/guard-profile/entities/guard-profile.entity';
import { GuardProfileService } from '../src/guard-profile/guard-profile.service';
import { UserRole, UserStatus } from '../src/user/entities/user.entity';

type AuditInput = Record<string, any>;

function buildApprovalHarness() {
  const audits: AuditInput[] = [];
  const guard = {
    id: 41,
    user: { id: 401 },
    status: GuardApprovalStatus.PENDING,
    approvalStatus: GuardApprovalStatus.PENDING,
    isApproved: false,
  };
  const company = { id: 51 };
  const guardRepo = {
    findOne: async () => guard,
    save: async (value: any) => value,
  };
  const companyGuardRepo = {
    findOne: async () => ({ id: 1, company, guard }),
    create: (value: any) => value,
    save: async (value: any) => value,
  };
  const userService = { updateStatus: async () => undefined };
  const companyService = { findByUserId: async () => company };
  const auditLogService = { log: async (value: AuditInput) => (audits.push(value), value) };
  const service = new GuardProfileService(
    guardRepo as any,
    companyGuardRepo as any,
    userService as any,
    companyService as any,
    auditLogService as any,
  );
  return { service, audits, guard, company };
}

function buildComplianceHarness(options: { crossTenant?: boolean; failSave?: boolean } = {}) {
  const audits: AuditInput[] = [];
  const guard = { id: 61, fullName: 'Release Guard' };
  let nextId = 700;
  let document: any = null;
  const guardDocumentRepo = {
    create: (value: any) => ({ id: nextId++, ...value }),
    save: async (value: any) => {
      if (options.failSave) throw new Error('simulated persistence failure');
      document = value;
      return value;
    },
    findOne: async () => (options.crossTenant ? null : document),
  };
  const company = { id: 71 };
  const companyGuardRepo = {
    find: async () => [{ id: 1, company, guard }],
    findOne: async () => (options.crossTenant ? null : { id: 1, company, guard }),
  };
  const companyService = { findByUserId: async () => company };
  const guardProfileService = {
    findOne: async () => guard,
    findByUserId: async () => guard,
  };
  const auditLogService = { log: async (value: AuditInput) => (audits.push(value), value) };
  const service = new GuardComplianceService(
    guardDocumentRepo as any,
    {} as any,
    companyGuardRepo as any,
    companyService as any,
    guardProfileService as any,
    {} as any,
    auditLogService as any,
  );
  return { service, audits, guard, company, setDocument: (value: any) => (document = value) };
}

async function upload(service: GuardComplianceService, type: GuardDocumentType) {
  return service.uploadDocumentForCompanyUser(81, {
    guardId: 61,
    type,
    fileUrl: 'https://private.example/document-token',
    expiryDate: '2027-12-31',
  });
}

async function testGuardApprovalCreatesAttributableAuditRow() {
  const { service, audits, company } = buildApprovalHarness();
  await service.approveForUser(
    { sub: 81, email: 'admin@example.test', role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE },
    41,
  );
  equal(audits.length, 1);
  equal(audits[0].action, 'guard.approved');
  equal(audits[0].user.id, 81);
  equal(audits[0].company.id, company.id);
  equal(audits[0].beforeData.approvalStatus, GuardApprovalStatus.PENDING);
  equal(audits[0].afterData.approvalStatus, GuardApprovalStatus.APPROVED);
}

async function testUploadCreatesAudit(type: GuardDocumentType) {
  const { service, audits, company } = buildComplianceHarness();
  const saved = await upload(service, type);
  equal(audits.length, 1);
  equal(audits[0].action, 'guard_document.uploaded');
  equal(audits[0].user.id, 81);
  equal(audits[0].company.id, company.id);
  equal(audits[0].entityId, saved.id);
  equal(audits[0].afterData.documentType, type);
}

async function testVerificationCreatesAudit(type: GuardDocumentType) {
  const { service, audits, guard, company, setDocument } = buildComplianceHarness();
  setDocument({ id: 701, guard, type, fileUrl: 'https://private.example/token', expiryDate: null, verified: false });
  await service.verifyDocumentForCompanyUser(81, 701, true);
  equal(audits.length, 1);
  equal(audits[0].action, 'guard_document.verified');
  equal(audits[0].user.id, 81);
  equal(audits[0].company.id, company.id);
  equal(audits[0].beforeData.verified, false);
  equal(audits[0].afterData.verified, true);
}

async function testCrossTenantFailureCreatesNoSuccessAudit() {
  const { service, audits, guard, setDocument } = buildComplianceHarness({ crossTenant: true });
  setDocument({ id: 701, guard, type: GuardDocumentType.SIA_LICENCE, verified: false });
  let error: unknown;
  try {
    await service.verifyDocumentForCompanyUser(81, 701, true);
  } catch (caught) {
    error = caught;
  }
  ok(error instanceof ForbiddenException || error instanceof NotFoundException);
  equal(audits.length, 0);
}

async function testFailedPersistenceCreatesNoSuccessAudit() {
  const { service, audits } = buildComplianceHarness({ failSave: true });
  await upload(service, GuardDocumentType.SIA_LICENCE).then(
    () => Promise.reject(new Error('Expected persistence failure')),
    () => undefined,
  );
  equal(audits.length, 0);
}

async function testAuditPayloadExcludesSecretsAndDocumentLocation() {
  const { service, audits } = buildComplianceHarness();
  await upload(service, GuardDocumentType.SIA_LICENCE);
  const payload = JSON.stringify(audits[0]);
  ok(!payload.includes('private.example'));
  ok(!payload.includes('fileUrl'));
  ok(!payload.includes('passwordHash'));
  ok(!payload.toLowerCase().includes('secret'));
}

async function main() {
  await testGuardApprovalCreatesAttributableAuditRow();
  await testUploadCreatesAudit(GuardDocumentType.SIA_LICENCE);
  await testVerificationCreatesAudit(GuardDocumentType.SIA_LICENCE);
  await testUploadCreatesAudit(GuardDocumentType.RIGHT_TO_WORK);
  await testVerificationCreatesAudit(GuardDocumentType.RIGHT_TO_WORK);
  await testCrossTenantFailureCreatesNoSuccessAudit();
  await testFailedPersistenceCreatesNoSuccessAudit();
  await testAuditPayloadExcludesSecretsAndDocumentLocation();
  console.log(JSON.stringify({ event: 'compliance_audit_release_tests_passed', tests: 8 }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
