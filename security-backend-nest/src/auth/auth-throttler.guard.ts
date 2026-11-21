import { createHash } from 'node:crypto';
import { ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { resolveClientIp } from '../common/http/client-ip';

/**
 * Rate limiting for unauthenticated and abuse-sensitive routes.
 *
 * Two independent limits, both of which must pass:
 *
 *  - `default`, per client IP. The IP is Express's trust-proxy-aware `req.ip` (resolveClientIp), never the
 *    client-settable first X-Forwarded-For entry (SEC-PUBLIC-02: rotating that value used to give every request a
 *    fresh bucket, so the limit never applied).
 *  - `account`, per target account (the normalised email in the body), only on routes marked @AccountThrottle(). It
 *    holds however many addresses an attacker controls: attempts against one account are capped wherever they come
 *    from. The key is a SHA-256 of the email, so the throttler's storage never holds an address.
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return resolveClientIp(req) ?? 'unknown-client';
  }
}

export const ACCOUNT_THROTTLE_KEY = 's4:account-throttle';
/** Applies the per-account limit (the `account` throttler) to a route whose body carries the account email. */
export const AccountThrottle = () => SetMetadata(ACCOUNT_THROTTLE_KEY, true);

/** Every sign-in attempt for one account counts, failed or not: 10 per 15 minutes. */
export const ACCOUNT_THROTTLE_LIMIT = 10;
export const ACCOUNT_THROTTLE_TTL_MS = 15 * 60_000;

export function accountThrottleKey(req: Record<string, any>): string {
  const email = typeof req?.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return `account:${createHash('sha256').update(email).digest('hex')}`;
}

/** The `account` throttler applies only to routes that opt in with @AccountThrottle(). */
export function skipUnlessAccountThrottled(context: ExecutionContext): boolean {
  return Reflect.getMetadata(ACCOUNT_THROTTLE_KEY, context.getHandler()) !== true;
}

/** The throttler definitions the module that registers AuthThrottlerGuard uses (ThrottlerModule.forRoot). */
export const AUTH_THROTTLERS = [
  { name: 'default', ttl: 60_000, limit: 6 },
  {
    name: 'account',
    ttl: ACCOUNT_THROTTLE_TTL_MS,
    limit: ACCOUNT_THROTTLE_LIMIT,
    getTracker: (req: Record<string, any>) => accountThrottleKey(req),
    skipIf: skipUnlessAccountThrottled,
  },
];
