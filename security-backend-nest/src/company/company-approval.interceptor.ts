import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { isCompanyRole } from '../user/entities/user.entity';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import {
  COMPANY_NOT_APPROVED_CODE,
  COMPANY_VERIFICATION_STATUSES,
  CompanyVerificationStatus,
  isCompanyApproved,
} from './company-verification';

export const ALLOW_UNAPPROVED_COMPANY_KEY = 's4:allow-unapproved-company';

/**
 * Marks a mutating company route a company that is not APPROVED may still use, and in which verification states. With
 * no argument, every state. Only for account housekeeping and safety (sign out, delete the account, correct the details
 * S4 is verifying, mark a notification read, act on a Guard's safety alert); never for an operational action.
 */
export const AllowUnapprovedCompany = (...statuses: CompanyVerificationStatus[]) =>
  SetMetadata(ALLOW_UNAPPROVED_COMPANY_KEY, statuses.length ? statuses : COMPANY_VERIFICATION_STATUSES);

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const REFUSAL_MESSAGES: Record<Exclude<CompanyVerificationStatus, CompanyVerificationStatus.APPROVED>, string> = {
  [CompanyVerificationStatus.PENDING_VERIFICATION]:
    'Your company is awaiting verification by S4. You can sign in and see your verification status; this action becomes available once S4 has approved your company.',
  [CompanyVerificationStatus.REJECTED]:
    'Your company was not approved by S4, so this action is not available. See your verification status for the reason.',
  [CompanyVerificationStatus.SUSPENDED]:
    'Your company has been suspended by S4, so this action is not available. See your verification status for the reason.',
};

/**
 * SEC-PUBLIC-03: only an APPROVED company may perform operational actions.
 *
 * Registered globally (APP_INTERCEPTOR), so it covers every route, including routes added later: every mutating request
 * (anything but GET / HEAD / OPTIONS) made by a company user (company, company_admin, company_staff) is refused with
 * 403 COMPANY_NOT_APPROVED unless the caller's company is APPROVED or the route opts in with @AllowUnapprovedCompany.
 * Interceptors run after the route's guards, so the caller is already authenticated (JwtAuthGuard) and authorised by
 * role (RolesGuard) when this runs.
 *
 * Reads stay open: a pending or rejected company has nothing to read but its own account and verification status, and a
 * suspended company keeps read access to its own records (it cannot change them).
 *
 * The company is the one the route itself would act on (CompanyMembershipService.resolveCompanyContext, the canonical
 * resolution). When it cannot be resolved (no company, a suspended or revoked membership), the request continues so the
 * route answers exactly as before; this interceptor only ever adds refusals.
 *
 * Guards, clients and platform administrators are not affected.
 */
@Injectable()
export class CompanyApprovalInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly membershipService: CompanyMembershipService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<{ method?: string; user?: JwtPayload }>();
    const user = request.user;
    if (!user || !isCompanyRole(user.role)) return next.handle();
    if (READ_ONLY_METHODS.has((request.method ?? 'GET').toUpperCase())) return next.handle();

    let status: CompanyVerificationStatus;
    try {
      const { company } = await this.membershipService.resolveCompanyContext(user.sub, user.role);
      if (isCompanyApproved(company)) return next.handle();
      status = company.verificationStatus;
    } catch {
      return next.handle();
    }

    const allowed = this.reflector.getAllAndOverride<readonly CompanyVerificationStatus[] | undefined>(
      ALLOW_UNAPPROVED_COMPANY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed?.includes(status)) return next.handle();

    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: COMPANY_NOT_APPROVED_CODE,
      verificationStatus: status,
      message: REFUSAL_MESSAGES[status as keyof typeof REFUSAL_MESSAGES] ?? REFUSAL_MESSAGES[CompanyVerificationStatus.PENDING_VERIFICATION],
    });
  }
}
