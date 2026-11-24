import { createHash } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { resolveClientIp } from '../common/http/client-ip';

/**
 * SEC-PUBLIC-02 (hardened): failed sign-in limiting that resists password guessing without letting anyone lock a
 * stranger out of their account.
 *
 * Only FAILED sign-ins (401 "Invalid credentials") count; a success clears the (account, source) counter. Three
 * independent limits, all per 15 minutes:
 *
 *   per (account, source)   5 failures    one source guessing one account: the classic attack, stopped quickly
 *   per source              30 failures   one source spraying many accounts (shared offices / NAT still get 30
 *                                         failures, far beyond what real colleagues mistype)
 *   per account             10 failures   many sources guessing ONE account (distributed guessing). When this trips,
 *                                         only sources that are NEW to the account are refused: a source that signed
 *                                         in to this account successfully in the last 30 days keeps working. So an
 *                                         attacker can no longer lock the real user out from where they normally sign
 *                                         in, and a user on a new network can always reset their password, which
 *                                         clears the account's counters.
 *
 * Successful sign-ins are not limited by these counters (only the request-rate cap of the route's throttler applies,
 * which is per source and generous enough for a shared public IP: 30 requests a minute).
 *
 * Neutral by construction: the counters count 401s, which the API returns identically for an unknown email and a
 * wrong password, and the refusal is the same 429 text either way, so the limiter reveals nothing about whether an
 * account exists. Keys are SHA-256 hashes: no email address is held in memory. "Source" is the trust-proxy-aware
 * client IP (resolveClientIp), never a client-settable header.
 *
 * In-memory and per instance (S4 runs one API instance). Bounded: at most MAX_ENTRIES keys per map, expired entries
 * pruned as they are met and the oldest evicted beyond the cap.
 */
export const LOGIN_LIMITS = {
  windowMs: 15 * 60_000,
  pairFailures: 5,
  sourceFailures: 30,
  accountFailures: 10,
  knownSourceMs: 30 * 24 * 60 * 60_000,
  knownSourcesPerAccount: 10,
} as const;
const MAX_ENTRIES = 50_000;

export const LOGIN_LIMITED_MESSAGE =
  'Too many unsuccessful sign-in attempts. Please wait 15 minutes and try again, or reset your password.';

/**
 * 'mfa' counts wrong Platform Admin authenticator codes (AdminMfaService), keyed by the admin's user id instead of an
 * email, with the same three limits: a source guessing codes is refused after 5 failures, and a code can be guessed
 * at most 10 times in 15 minutes from sources the admin has not completed two-step sign-in from.
 */
export type LoginScope = 'user' | 'client' | 'mfa';
type Counter = { count: number; resetAt: number };

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const normaliseLoginEmail = (email: unknown) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

@Injectable()
export class LoginAttemptLimiter {
  private readonly pairs = new Map<string, Counter>();
  private readonly sources = new Map<string, Counter>();
  private readonly accounts = new Map<string, Counter>();
  /** account key → (source → last successful sign-in time) */
  private readonly known = new Map<string, Map<string, number>>();
  /** For tests: the clock. */
  now: () => number = () => Date.now();

  private accountKey(scope: LoginScope, email: unknown) { return `${scope}:${hash(normaliseLoginEmail(email))}`; }
  private sourceKey(source: string) { return hash(`source:${source}`); }

  private read(map: Map<string, Counter>, key: string): number {
    const c = map.get(key);
    if (!c) return 0;
    if (c.resetAt <= this.now()) { map.delete(key); return 0; }
    return c.count;
  }

  private bump(map: Map<string, Counter>, key: string) {
    const now = this.now();
    const c = map.get(key);
    if (c && c.resetAt > now) { c.count += 1; return; }
    map.delete(key);
    if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value as string);
    map.set(key, { count: 1, resetAt: now + LOGIN_LIMITS.windowMs });
  }

  private isKnown(account: string, source: string): boolean {
    const at = this.known.get(account)?.get(this.sourceKey(source));
    return at !== undefined && this.now() - at < LOGIN_LIMITS.knownSourceMs;
  }

  /** True when this sign-in attempt must be refused before the password is even checked. */
  isLimited(scope: LoginScope, email: unknown, source: string): boolean {
    const account = this.accountKey(scope, email);
    const src = this.sourceKey(source);
    if (this.read(this.pairs, `${account}|${src}`) >= LOGIN_LIMITS.pairFailures) return true;
    if (this.read(this.sources, src) >= LOGIN_LIMITS.sourceFailures) return true;
    if (this.read(this.accounts, account) >= LOGIN_LIMITS.accountFailures && !this.isKnown(account, source)) return true;
    return false;
  }

  recordFailure(scope: LoginScope, email: unknown, source: string) {
    const account = this.accountKey(scope, email);
    const src = this.sourceKey(source);
    this.bump(this.pairs, `${account}|${src}`);
    this.bump(this.sources, src);
    this.bump(this.accounts, account);
  }

  recordSuccess(scope: LoginScope, email: unknown, source: string) {
    const account = this.accountKey(scope, email);
    const src = this.sourceKey(source);
    this.pairs.delete(`${account}|${src}`);
    let sources = this.known.get(account);
    if (!sources) {
      if (this.known.size >= MAX_ENTRIES) this.known.delete(this.known.keys().next().value as string);
      sources = new Map();
      this.known.set(account, sources);
    }
    sources.delete(src);
    sources.set(src, this.now());
    while (sources.size > LOGIN_LIMITS.knownSourcesPerAccount) sources.delete(sources.keys().next().value as string);
  }

  /** A completed password reset proves control of the mailbox: the account's failure counters start again. */
  clearAccount(scope: LoginScope, email: unknown) {
    const account = this.accountKey(scope, email);
    this.accounts.delete(account);
    for (const key of [...this.pairs.keys()]) if (key.startsWith(`${account}|`)) this.pairs.delete(key);
  }
}

/** Marks a sign-in route for the limiter; `scope` separates staff/Guard accounts from client-portal accounts. */
export function loginAttemptInterceptor(scope: LoginScope) {
  @Injectable()
  class LoginAttemptInterceptor implements NestInterceptor {
    constructor(readonly limiter: LoginAttemptLimiter) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
      const req = context.switchToHttp().getRequest();
      const email = req?.body?.email;
      const source = resolveClientIp(req) ?? 'unknown-client';
      if (this.limiter.isLimited(scope, email, source)) {
        throw new HttpException(
          { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests', message: LOGIN_LIMITED_MESSAGE },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return next.handle().pipe(
        tap(() => this.limiter.recordSuccess(scope, email, source)),
        catchError((error) => {
          if (error instanceof UnauthorizedException) this.limiter.recordFailure(scope, email, source);
          return throwError(() => error);
        }),
      );
    }
  }
  return LoginAttemptInterceptor;
}

export const UserLoginAttemptInterceptor = loginAttemptInterceptor('user');
export const ClientLoginAttemptInterceptor = loginAttemptInterceptor('client');
