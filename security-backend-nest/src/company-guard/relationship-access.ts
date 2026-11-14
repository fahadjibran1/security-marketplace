import { ForbiddenException } from '@nestjs/common';
import { EntityManager, In, Repository } from 'typeorm';

import { CompanyGuard, CompanyGuardStatus } from './entities/company-guard.entity';

/**
 * What a company is doing with a guard's data, which decides the relationship statuses that allow it (SEC-001B 2A).
 *
 * A company keeps its own HISTORY about a guard after the relationship ends (INACTIVE) or is blocked (BLOCKED): the
 * shifts, leave, compliance records, document list and employment record it created while the guard worked for it.
 * It does not keep the guard's CURRENT personal data, and it may not WRITE records about the guard any more.
 * Retaining a historical record never authorises access to current profile data.
 */
export enum GuardRelationshipAccess {
  /** The guard's current personal data: what the guard keeps for themselves (e.g. their own availability). */
  CURRENT = 'current',
  /** Creating or changing any record about the guard. */
  WRITE = 'write',
  /** Reading the company's own historical records about the guard. */
  HISTORY = 'history',
}

const ALLOWED_STATUSES: Record<GuardRelationshipAccess, readonly CompanyGuardStatus[]> = {
  [GuardRelationshipAccess.CURRENT]: [CompanyGuardStatus.ACTIVE],
  [GuardRelationshipAccess.WRITE]: [CompanyGuardStatus.ACTIVE],
  [GuardRelationshipAccess.HISTORY]: [CompanyGuardStatus.ACTIVE, CompanyGuardStatus.INACTIVE, CompanyGuardStatus.BLOCKED],
};

export function relationshipStatusesFor(access: GuardRelationshipAccess): readonly CompanyGuardStatus[] {
  return ALLOWED_STATUSES[access];
}

/** Whether a relationship (or its absence) allows this access. No relationship never allows anything. */
export function relationshipAllows(
  relation: Pick<CompanyGuard, 'status'> | null | undefined,
  access: GuardRelationshipAccess,
): boolean {
  return !!relation && ALLOWED_STATUSES[access].includes(relation.status);
}

type RelationSource = Repository<CompanyGuard> | EntityManager;
const repoOf = (source: RelationSource): Repository<CompanyGuard> =>
  source instanceof EntityManager ? source.getRepository(CompanyGuard) : source;

/** The status condition: a plain equality when one status is allowed (ACTIVE), otherwise IN (...). */
const statusCondition = (access: GuardRelationshipAccess) => {
  const statuses = ALLOWED_STATUSES[access];
  return statuses.length === 1 ? statuses[0] : In([...statuses]);
};

/**
 * The relationship between a company and a guard that allows this access, or null. `companyId` MUST come from the
 * caller's resolved company context, never from the request.
 */
export async function findGuardRelationship(
  source: RelationSource,
  companyId: number,
  guardId: number,
  access: GuardRelationshipAccess,
): Promise<CompanyGuard | null> {
  // (company, guard) is unique, so at most one row matches.
  const [relation] = await repoOf(source).find({
    where: { company: { id: companyId }, guard: { id: guardId }, status: statusCondition(access) },
    take: 1,
  });
  return relation ?? null;
}

/**
 * As findGuardRelationship, but refuses when the access is not allowed. An unrelated guard, a guard id that does not
 * exist and a relationship in the wrong status all produce the same refusal, so the response never reveals whether an
 * unrelated guard exists. Callers pass the refusal their route already uses, so existing clients see no new message.
 */
export async function requireGuardRelationship(
  source: RelationSource,
  companyId: number,
  guardId: number,
  access: GuardRelationshipAccess,
  refusal: () => Error = () => new ForbiddenException('Guard is not available to this company.'),
): Promise<CompanyGuard> {
  const relation = await findGuardRelationship(source, companyId, guardId, access);
  if (!relation) throw refusal();
  return relation;
}

/** Every guard of this company whose relationship allows this access. */
export async function guardIdsWithAccess(
  source: RelationSource,
  companyId: number,
  access: GuardRelationshipAccess,
): Promise<number[]> {
  const rows = await repoOf(source).find({
    where: { company: { id: companyId }, status: statusCondition(access) },
  });
  return rows.map((row) => row.guard.id);
}
