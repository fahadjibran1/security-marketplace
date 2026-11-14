import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { from, mergeMap, Observable } from 'rxjs';
import { DataSource, In } from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { isCompanyRole, User } from '../../user/entities/user.entity';

/**
 * Defence in depth for company-facing responses that still return TypeORM entities.
 *
 * Many company routes return entities whose eager relations pull in a guard's full profile and user account, and
 * the company owner's user account (Company.user). Purpose-built DTOs are the primary control (the workforce list and
 * GET /guards have them); this projection makes sure that, on the routes listed below, those three entity types can
 * only ever reach a company user as:
 *
 *   GuardProfile → { id, fullName }
 *   User         → an actor reference: { id, firstName, lastName, email } for staff and other non-guard accounts,
 *                  { id, firstName: <guard profile name>, lastName: null } for a guard's account (no email)
 *   Company      → the company record without its owner's `user` account
 *
 * It changes nothing else:
 *   - only for requests made by a company user (company, company_admin, company_staff); Platform Admin, guards and
 *     client-portal users get the handler's value untouched;
 *   - only TypeORM entity instances are rewritten. Plain objects and arrays are walked to reach entities nested in
 *     them, and copied key for key, so a hand-built DTO serialises exactly as before. Any other class instance
 *     (StreamableFile, Buffer, Date, …) is returned as is;
 *   - only on the controllers in COMPANY_PRIVACY_SCOPED_ROUTES, each of which applies it explicitly with
 *     @UseInterceptors. It is never registered globally (company-response-privacy.spec.ts checks both).
 */
export const COMPANY_PRIVACY_SCOPED_ROUTES: readonly string[] = [
  'alerts',
  'assignments',
  'attachments',
  'attendance',
  'audit-logs',
  'availability',
  'client-portal-users',
  'clients',
  'companies',
  'company-guards',
  'compliance',
  'contract-pricing',
  'daily-logs',
  'guards',
  'incidents',
  'invoice-batches',
  'job-applications',
  'job-slots',
  'jobs',
  'leave',
  'notifications',
  'pay-rules',
  'payroll-batches',
  'shifts',
  'sites',
  'timesheets',
  'timesheets/weekly-approvals',
];

export interface GuardRef {
  id: number;
  fullName: string;
}
export interface ActorRef {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email?: string;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Rewrites a response value for a company user, as described above. Exported for the spec; the interceptor is the
 * only production caller.
 */
export async function projectCompanyResponse(dataSource: DataSource, value: unknown): Promise<unknown> {
  const entityTargets = new Set<unknown>(dataSource.entityMetadatas.map((m) => m.target));
  const isEntity = (obj: object) => entityTargets.has(obj.constructor);

  // Pass 1: every user account in the response, and the guard-profile names already at hand.
  const userIds = new Set<number>();
  const guardNameByUserId = new Map<number, string>();
  const collected = new WeakSet<object>();
  const collect = (node: unknown): void => {
    if (!node || typeof node !== 'object' || collected.has(node)) return;
    collected.add(node);
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    if (!isPlainObject(node) && !isEntity(node)) return;
    if (node instanceof User) {
      if (typeof node.id === 'number') userIds.add(node.id);
      return;
    }
    if (node instanceof GuardProfile) {
      if (node.user?.id != null) guardNameByUserId.set(node.user.id, node.fullName);
      return;
    }
    for (const child of Object.values(node)) collect(child);
  };
  collect(value);

  // A user account belongs to a guard exactly when a guard profile points at it; look up the ones not seen above.
  const unresolved = [...userIds].filter((id) => !guardNameByUserId.has(id));
  if (unresolved.length) {
    const profiles = await dataSource.getRepository(GuardProfile).find({
      where: { user: { id: In(unresolved) } },
      select: { id: true, fullName: true, user: { id: true } },
      relations: { user: true },
    });
    for (const profile of profiles) guardNameByUserId.set(profile.user.id, profile.fullName);
  }

  // Pass 2: rebuild, rewriting the three entity types. Shared references stay shared; cycles are cut.
  const done = new Map<object, unknown>();
  const project = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node;
    if (done.has(node)) return done.get(node);
    if (node instanceof GuardProfile) {
      const ref: GuardRef = { id: node.id, fullName: node.fullName };
      done.set(node, ref);
      return ref;
    }
    if (node instanceof User) {
      const guardName = guardNameByUserId.get(node.id);
      const ref: ActorRef = guardName !== undefined
        ? { id: node.id, firstName: guardName, lastName: null }
        : { id: node.id, firstName: node.firstName ?? null, lastName: node.lastName ?? null, email: node.email };
      done.set(node, ref);
      return ref;
    }
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      done.set(node, out);
      for (const item of node) out.push(project(item));
      return out;
    }
    if (!isPlainObject(node) && !isEntity(node)) return node;

    const out: Record<string, unknown> = {};
    done.set(node, out);
    const dropOwner = node instanceof Company;
    for (const [key, child] of Object.entries(node)) {
      if (dropOwner && key === 'user') continue;
      out[key] = project(child);
    }
    return out;
  };
  return project(value);
}

/**
 * The DataSource is resolved from ModuleRef on first use (globally, not from the controller's own module), so attaching
 * this interceptor adds no constructor dependency to any controller's module: a module compiled on its own — as the
 * DI boot regression does — still compiles. In the running app it is TypeORM's root DataSource. If it could not be
 * resolved, the request fails rather than returning an unprojected body.
 */
@Injectable()
export class CompanyResponsePrivacyInterceptor implements NestInterceptor {
  private dataSource?: DataSource;

  constructor(private readonly moduleRef: ModuleRef) {}

  private getDataSource(): DataSource {
    this.dataSource ??= this.moduleRef.get(DataSource, { strict: false });
    return this.dataSource;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const role = context.switchToHttp().getRequest()?.user?.role;
    if (!isCompanyRole(role)) return next.handle();
    return next.handle().pipe(mergeMap((body) => from(projectCompanyResponse(this.getDataSource(), body))));
  }
}
