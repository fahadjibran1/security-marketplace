import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { UserRole } from '../../user/entities/user.entity';
import { StreamableFile } from '@nestjs/common';
import { Readable } from 'node:stream';
import { Company } from '../../company/entities/company.entity';
import { User } from '../../user/entities/user.entity';
import { Client } from '../../client/entities/client.entity';
import { ClientPortalUser } from '../../client-portal-user/entities/client-portal-user.entity';
import { Site } from '../../site/entities/site.entity';
import { Job } from '../../job/entities/job.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';

/**
 * SEC-PUBLIC-04: what a Guard may be shown of the records nested in any response.
 *
 * Many Guard routes return TypeORM entities whose eager relations reach far beyond what a Guard needs: every Company
 * carries its owner's User account, every Site its Client's private contacts, a Job its billing rate, a Timesheet the
 * client charge, revenue and margin. This projection is applied to EVERY response to a Guard (GuardResponsePrivacyInterceptor,
 * registered globally), at every depth, so a nested record is reduced the same way wherever it appears and a route added
 * later is covered without opting in:
 *
 *   Company           { id, name }                       the employer's name; never the owner account, company number,
 *                                                         contact details, verification note or settings
 *   User              { id }                             never an email, phone, role or login history
 *   Client / ClientPortalUser   removed                  a Guard never needs the client's people
 *   Site              operational allow-list             what a Guard on shift needs: location, geofence, instructions,
 *                                                         the site contact line, timezone (never the client, never the
 *                                                         NFC tag secret, which is not selected anyway)
 *   Job               the Guard job fields               title, description, own pay (hourlyRate), times; never billingRate
 *   GuardProfile      { id, fullName }                   own full profile is served by /guards/me (its own DTO)
 *   any object        FINANCIAL_KEYS removed             client charge, revenue, cost, margin, contract rule, invoice
 *                                                         and payroll batch fields; the Guard's own pay stays
 *
 * Every other entity keeps its own scalar fields (the route's own payload, e.g. a shift's times, a timesheet's hours),
 * with each nested value projected by the same rules. Every other object (explicit views, unregistered
 * entities) is walked the same way, so a nested entity inside a view is still projected.
 */
const COMPANY_FIELDS = ['id', 'name'] as const;
const USER_FIELDS = ['id'] as const;
const GUARD_PROFILE_FIELDS = ['id', 'fullName'] as const;
const SITE_FIELDS = [
  'id', 'name', 'address', 'contactDetails', 'status', 'timezone', 'latitude', 'longitude', 'geofenceRadiusMeters',
  'requireGpsCheckIn', 'requireNfcCheckIn', 'specialInstructions', 'welfareCheckIntervalMinutes', 'logBookIntervalMinutes',
  'operatingDays', 'operatingStartTime', 'operatingEndTime',
] as const;
const JOB_FIELDS = ['id', 'title', 'description', 'guardsRequired', 'hourlyRate', 'status', 'startAt', 'endAt', 'company', 'site'] as const;
const REMOVED_CLASSES: Function[] = [Client, ClientPortalUser];

/** Company / client money, never a Guard's business. The Guard's own pay (hourlyRate, payable*) is not listed. */
export const FINANCIAL_KEYS = new Set([
  'billingRate', 'billingRateSnapshot', 'effectiveBillingRate', 'billableHours', 'billingStatus',
  'revenueAmount', 'costAmount', 'marginAmount', 'marginPercent', 'matchedContractRuleId', 'matchedContractRuleName',
  'clientBilledHoursSnapshot', 'clientBillingApprovedStartAt', 'clientBillingApprovedEndAt', 'clientBillingApprovedMinutes',
  'clientBillingCorrectionReason', 'invoiceIssuedAt', 'invoicePaidAt', 'invoiceBatch', 'invoiceBatchId', 'payrollBatch',
  'payrollBatchId', 'chargeRate', 'passwordHash',
]);

const REMOVE = Symbol('remove');

function pick(source: any, fields: readonly string[], seen: WeakMap<object, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!(f in source)) continue;
    const v = project(source[f], seen);
    if (v !== REMOVE) out[f] = v;
  }
  return out;
}

function project(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) {
      const v = project(item, seen);
      if (v !== REMOVE) out.push(v);
    }
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  const ctor = proto?.constructor as Function | undefined;
  if (ctor && REMOVED_CLASSES.includes(ctor)) return REMOVE;
  if (value instanceof Company) return memo(value, seen, () => pick(value, COMPANY_FIELDS, seen));
  if (value instanceof User) return memo(value, seen, () => pick(value, USER_FIELDS, seen));
  if (value instanceof GuardProfile) return memo(value, seen, () => pick(value, GUARD_PROFILE_FIELDS, seen));
  if (value instanceof Site) return memo(value, seen, () => pick(value, SITE_FIELDS, seen));
  if (value instanceof Job) return memo(value, seen, () => pick(value, JOB_FIELDS, seen));
  // Values, not records: unchanged. Every other object (entities, views, nested plain objects) is walked: fail closed.
  if (value instanceof Date || value instanceof StreamableFile || value instanceof Readable || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) {
    if (FINANCIAL_KEYS.has(k)) continue;
    const p = project(v, seen);
    if (p !== REMOVE) out[k] = p;
  }
  return out;
}

function memo(value: object, seen: WeakMap<object, unknown>, build: () => Record<string, unknown>) {
  const placeholder: Record<string, unknown> = {};
  seen.set(value, placeholder);
  return Object.assign(placeholder, build());
}

/** The Guard projection of any response body (exported for the regression specs). */
export function projectGuardResponse<T>(body: T): unknown {
  const v = project(body, new WeakMap());
  return v === REMOVE ? null : v;
}

/** Applies projectGuardResponse to every response to a Guard. Registered globally in AppModule. */
@Injectable()
export class GuardResponsePrivacyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    if (context.switchToHttp().getRequest()?.user?.role !== UserRole.GUARD) return next.handle();
    return next.handle().pipe(map((body) => projectGuardResponse(body)));
  }
}
