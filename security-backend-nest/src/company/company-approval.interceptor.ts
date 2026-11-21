import { CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyService } from './company.service';
import { isCompanyRole } from '../user/entities/user.entity';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { COMPANY_NOT_APPROVED_CODE, CompanyVerificationStatus } from './company-verification';
import { COMPANY_CAPABILITY_KEY, CompanyCapability, companyMay } from './company-capability';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const REFUSAL_MESSAGES: Record<Exclude<CompanyVerificationStatus, CompanyVerificationStatus.APPROVED>, string> = {
  [CompanyVerificationStatus.PENDING_VERIFICATION]:
    'Your company is awaiting verification by S4. You can set up your account in the meantime; this action becomes available once S4 has approved your company.',
  [CompanyVerificationStatus.REJECTED]:
    'Your company was not approved by S4, so this action is not available. See your verification status for the reason; you can correct your details and ask S4 to reconsider.',
  [CompanyVerificationStatus.SUSPENDED]:
    'Your company has been suspended by S4. Existing work, safety alerts and records remain available, but this action is not. See your verification status for the reason.',
};

/** Most restrictive first: when a user can act for more than one company, the least-trusted one decides. */
const RESTRICTIVENESS: CompanyVerificationStatus[] = [
  CompanyVerificationStatus.REJECTED,
  CompanyVerificationStatus.SUSPENDED,
  CompanyVerificationStatus.PENDING_VERIFICATION,
  CompanyVerificationStatus.APPROVED,
];

/**
 * SEC-PUBLIC-03: enforces the company capability policy (company-capability.ts) on every route.
 *
 * Registered globally (APP_INTERCEPTOR), it sees every request after the route's guards (so the caller is authenticated
 * and authorised by role). For a company user (company, company_admin, company_staff) making a mutating request, the
 * route's capability (@CompanyCapabilityRequired, NEW_OPERATIONS when absent) must be granted to the verification state
 * of EVERY company the user can act for: the company resolveCompanyContext resolves (the one nearly every route acts on)
 * AND the company the user owns (the direct owner lookup some routes use, e.g. sites). The most restrictive state wins,
 * so being active in an approved company never unlocks a pending one, whichever lookup a route uses.
 *
 * When no company can be resolved at all, the request continues and the route answers exactly as before (it fails the
 * same way); this interceptor only ever adds refusals. Reads are never refused. Guards, clients and platform
 * administrators are not affected.
 */
@Injectable()
export class CompanyApprovalInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly membershipService: CompanyMembershipService,
    private readonly companyService: CompanyService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<{ method?: string; user?: JwtPayload }>();
    const user = request.user;
    if (!user || !isCompanyRole(user.role)) return next.handle();
    if (READ_ONLY_METHODS.has((request.method ?? 'GET').toUpperCase())) return next.handle();

    const status = await this.effectiveStatus(user);
    if (status === null || status === CompanyVerificationStatus.APPROVED) return next.handle();

    const capability =
      this.reflector.getAllAndOverride<CompanyCapability | undefined>(COMPANY_CAPABILITY_KEY, [context.getHandler(), context.getClass()]) ??
      CompanyCapability.NEW_OPERATIONS;
    if (companyMay(status, capability)) return next.handle();

    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: COMPANY_NOT_APPROVED_CODE,
      verificationStatus: status,
      capability,
      message: REFUSAL_MESSAGES[status as keyof typeof REFUSAL_MESSAGES],
    });
  }

  /** The most restrictive verification state among the companies this user can act for; null when there are none. */
  private async effectiveStatus(user: JwtPayload): Promise<CompanyVerificationStatus | null> {
    const statuses: CompanyVerificationStatus[] = [];
    try {
      const { company } = await this.membershipService.resolveCompanyContext(user.sub, user.role);
      if (company?.verificationStatus) statuses.push(company.verificationStatus);
    } catch {
      // no resolvable company (or a suspended / revoked membership): the route itself refuses, as before
    }
    const owned = await this.companyService.findByUserId(user.sub).catch(() => null);
    if (owned?.verificationStatus) statuses.push(owned.verificationStatus);
    if (!statuses.length) return null;
    return RESTRICTIVENESS.find((s) => statuses.includes(s)) ?? null;
  }
}
