/**
 * Test fixtures for company-recorded compliance checks (Migration 62).
 *
 * Since Migration 62 a company's assessment of a Guard needs that company's own current SIA and Right
 * to Work checks. Specs written before it, which construct GuardComplianceService with in-memory fakes
 * and test something else (documents, evidence storage, tenant isolation of documents), use
 * `confirmedChecksRepo` so that the checks requirement is met and their original subject is still what
 * decides the outcome. The checks requirement itself, and its isolation, are tested in
 * scripts/company-compliance-checks.spec.ts against a real database.
 */

import { IsNull } from 'typeorm';

const farFuture = () => {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() + 2);
  return date.toISOString().slice(0, 10);
};

export function confirmedChecks(companyId: number, guardId: number) {
  const base = {
    companyId, guardId, outcome: 'confirmed', checkDate: '2026-01-05', workRestrictions: null,
    checkedByName: 'Fixture Checker', evidenceReference: 'fixture', evidenceDocumentId: null,
    recordedByUserId: null, changeType: 'new_check', changeReason: null, supersededAt: null,
    supersededByCheckId: null, createdAt: new Date('2026-01-05T09:00:00Z'),
  };
  return [
    { ...base, id: guardId * 10 + 1, kind: 'sia', method: 'sia_public_register', rightToWorkExcuse: null, licenceNumber: '1000000000000001', expiryDate: farFuture() },
    { ...base, id: guardId * 10 + 2, kind: 'right_to_work', method: 'manual_document', rightToWorkExcuse: 'continuous', licenceNumber: null, expiryDate: null },
  ];
}

type CheckOverrides = {
  sia?: Record<string, unknown> | null;
  rightToWork?: Record<string, unknown> | null;
};

/**
 * Inserts a company's current SIA and Right to Work checks for a Guard straight into a real
 * guard_compliance_checks repository (fixture only: the recording service and its validation are
 * tested in company-compliance-checks.spec.ts). Pass null to leave a kind unrecorded, or an object
 * to override fields of that kind's check.
 */
export async function insertCompanyChecks(
  repo: { save: (row: any) => Promise<unknown>; create: (row: any) => any; count: (options: any) => Promise<number> },
  companyId: number,
  guardId: number,
  overrides: CheckOverrides = {},
) {
  const [sia, rightToWork] = confirmedChecks(companyId, guardId).map(({ id, createdAt, ...row }) => row);
  // A kind that already has a current check is left alone, so a fixture can "complete the file" twice.
  const hasCurrent = (kind: string) => repo.count({ where: { companyId, guardId, kind, supersededAt: IsNull() } });
  if (overrides.sia !== null && !(await hasCurrent('sia'))) {
    await repo.save(repo.create({ ...sia, ...(overrides.sia ?? {}) }));
  }
  if (overrides.rightToWork !== null && !(await hasCurrent('right_to_work'))) {
    await repo.save(repo.create({ ...rightToWork, ...(overrides.rightToWork ?? {}) }));
  }
}

/** A fake guard_compliance_checks repository: every company has confirmed checks for every Guard. */
export const confirmedChecksRepo = {
  find: async ({ where }: { where: { companyId: number; guardId: number } }) => confirmedChecks(where.companyId, where.guardId),
};
