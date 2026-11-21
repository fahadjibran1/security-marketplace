import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { resolveClientIp } from '../common/http/client-ip';

/**
 * Request-rate limiting for unauthenticated and abuse-sensitive routes, per client IP.
 *
 * The IP is Express's trust-proxy-aware `req.ip` (resolveClientIp), never the client-settable first X-Forwarded-For
 * entry (SEC-PUBLIC-02: rotating that value used to give every request a fresh bucket, so the limit never applied).
 *
 * This is only a request-rate cap. Password guessing is limited separately, by FAILED sign-ins, in
 * LoginAttemptLimiter (per account and source, per source, and per account with a known-source exemption), which a
 * shared office or mobile-carrier IP does not trip by signing in successfully, and which cannot be used to lock a user
 * out from where they normally sign in.
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return resolveClientIp(req) ?? 'unknown-client';
  }
}

/**
 * Sign-in requests per client IP per minute. Generous on purpose: many legitimate users can share one public IP (an
 * office, a site's guest Wi-Fi, a mobile carrier's NAT), and guessing is held by the failure limits, not by this cap.
 */
export const LOGIN_REQUESTS_PER_MINUTE = 30;

/** The throttler definitions the module that registers AuthThrottlerGuard uses (ThrottlerModule.forRoot). */
export const AUTH_THROTTLERS = [{ name: 'default', ttl: 60_000, limit: 6 }];
