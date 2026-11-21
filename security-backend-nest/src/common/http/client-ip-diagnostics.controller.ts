import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Roles } from '../decorators/roles.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { UserRole } from '../../user/entities/user.entity';
import { resolveClientIp } from './client-ip';

/**
 * SEC-PUBLIC-02 verification gate (docs/runbooks/DEPLOYMENT.md, "Client IP verification"): shows a platform
 * administrator how the API sees THEIR OWN request, so the deployed TRUST_PROXY hop count can be checked against the
 * real proxy chain before the sign-in limits are relied on.
 *
 * It is the only code that reads the forwarded-for chain, and only to DISPLAY it to the administrator who sent it. No
 * decision anywhere uses it: rate limits, audit logs and invitations use resolveClientIp (req.ip under trust proxy)
 * alone, which auth-rate-limit.spec.ts enforces.
 */
@Controller('admin/diagnostics')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class ClientIpDiagnosticsController {
  @Get('client-ip')
  clientIp(@Req() req: any) {
    const raw = req?.headers?.['x-forwarded-for'];
    const chain = (Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : '')
      .split(',').map((s: string) => s.trim()).filter(Boolean);
    return {
      resolvedClientIp: resolveClientIp(req),
      trustProxy: req?.app?.get?.('trust proxy') ?? null,
      forwardedForEntries: chain.length,
      forwardedFor: chain,
      socketAddress: req?.socket?.remoteAddress ?? null,
      cdnHeadersPresent: {
        cfConnectingIp: Boolean(req?.headers?.['cf-connecting-ip']),
        trueClientIp: Boolean(req?.headers?.['true-client-ip']),
        xRealIp: Boolean(req?.headers?.['x-real-ip']),
      },
    };
  }
}
