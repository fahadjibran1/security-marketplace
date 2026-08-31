import { equal, ok } from 'node:assert/strict';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GuardComplianceService } from '../src/compliance/guard-compliance.service';
import { GuardDocumentType } from '../src/compliance/entities/guard-document.entity';
import { UserRole, UserStatus } from '../src/user/entities/user.entity';

const companyA = { id: 11 };
const companyB = { id: 22 };
const guard = { id: 33, fullName: 'Shared Guard', user: { id: 330 } };
const metadata = { originalFileName: 'sia-evidence.pdf', mimeType: 'application/pdf', sizeBytes: 2048 };
const user = (sub: number, role: UserRole) => ({ sub, role, email: `${sub}@test`, status: UserStatus.ACTIVE });

function buildHarness() {
  const documents: any[] = [];
  const audits: any[] = [];
  const signed: any[] = [];
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
  const storage = {
    provider: 's3-compatible',
    createSignedUploadUrl: async (object: any) => {
      signed.push({ operation: 'upload', ...object });
      return { url: `https://objects.example/${object.key}?signature=upload`, expiresAt: new Date(Date.now() + 180000).toISOString(), method: 'PUT', headers: { 'Content-Type': object.mimeType } };
    },
    createSignedDownloadUrl: async (object: any) => {
      signed.push({ operation: 'download', ...object });
      return { url: `https://objects.example/${object.key}?signature=download`, expiresAt: new Date(Date.now() + 180000).toISOString(), method: 'GET' };
    },
    verifyUpload: async (object: any, expectedSizeBytes: number) => signed.push({ operation: 'verify', expectedSizeBytes, ...object }),
  };
  const service = new GuardComplianceService(
    repo as any,
    { find: async () => [] } as any,
    { find: async () => [{ id: 1, guard, company: companyA }] } as any,
    { findByUserId: async (id: number) => id === 101 ? companyA : id === 202 ? companyB : null } as any,
    { findOne: async () => guard, findByUserId: async (id: number) => id === 330 ? guard : null } as any,
    {} as any,
    { log: async (entry: any) => (audits.push(entry), entry) } as any,
    { authorize: async (companyId: number) => ({ guard, companyId }) } as any,
    storage as any,
  );
  return { service, documents, audits, signed };
}

async function expectDenied(work: () => Promise<unknown>) {
  let error: unknown;
  try { await work(); } catch (caught) { error = caught; }
  ok(error instanceof ForbiddenException || error instanceof NotFoundException);
  return error;
}

async function main() {
  const { service, documents, audits, signed } = buildHarness();
  const a = await service.uploadDocumentForCompanyUser(101, { guardId: guard.id, type: GuardDocumentType.SIA_LICENCE, ...metadata });
  ok(a.upload.url.includes('/compliance/company/11/33/'));
  ok(new Date(a.upload.expiresAt).getTime() - Date.now() <= 180000);
  ok(!JSON.stringify(a).includes('storageKey') && !JSON.stringify(a).includes('fileUrl'));
  ok(/^compliance\/company\/11\/33\/[0-9a-f-]{36}$/.test(signed[0].key));
  await expectDenied(() => service.createDocumentAccess(user(101, UserRole.COMPANY_ADMIN), a.id));
  await service.completeDocumentUpload(user(101, UserRole.COMPANY_ADMIN), a.id);

  const accessA = await service.createDocumentAccess(user(101, UserRole.COMPANY_ADMIN), a.id);
  equal(accessA.method, 'GET');
  ok(accessA.url.includes(signed[0].key));
  await expectDenied(() => service.createDocumentAccess(user(202, UserRole.COMPANY_ADMIN), a.id));

  const b = await service.uploadDocumentForCompanyUser(202, { guardId: guard.id, type: GuardDocumentType.RIGHT_TO_WORK, ...metadata });
  await service.completeDocumentUpload(user(202, UserRole.COMPANY_ADMIN), b.id);
  await service.createDocumentAccess(user(202, UserRole.COMPANY_ADMIN), b.id);
  await expectDenied(() => service.createDocumentAccess(user(101, UserRole.COMPANY_ADMIN), b.id));

  await service.createDocumentAccess(user(330, UserRole.GUARD), a.id);
  await expectDenied(() => service.createDocumentAccess(user(999, UserRole.GUARD), a.id));
  await expectDenied(() => service.createDocumentAccess(user(501, UserRole.CLIENT_ADMIN), a.id));
  const guessed = await expectDenied(() => service.createDocumentAccess(user(101, UserRole.COMPANY_ADMIN), 99999));
  ok(!JSON.stringify(guessed).includes('storageKey') && !JSON.stringify(guessed).includes('objects.example'));

  const list = await service.listDocumentsForCompanyUser(101, guard.id);
  ok(!JSON.stringify(list).includes('fileUrl') && !JSON.stringify(list).includes('storageKey') && !JSON.stringify(list).includes('signature='));
  const accessAudit = audits.find((entry) => entry.action === 'guard_document.accessed');
  ok(accessAudit && !JSON.stringify(accessAudit).includes('signature=') && !JSON.stringify(accessAudit).includes('storageKey'));
  ok(!JSON.stringify(accessA).includes('access-key') && !JSON.stringify(accessA).includes('secret'));
  ok(documents.every((document) => document.fileUrl === null));

  console.log(JSON.stringify({ event: 'private_evidence_access_tests_passed', tests: 15 }));
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
