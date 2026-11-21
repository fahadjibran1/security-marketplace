/**
 * Authentication rate limits (SEC-PUBLIC-02, hardened), over real HTTP against the real AuthController and
 * AccountRecoveryController with the production `trust proxy` setting (1 hop) and the real LoginAttemptLimiter.
 *
 * In production the proxy APPENDS the address it received the connection from to whatever X-Forwarded-For the client
 * sent. Here the test plays both parts: everything left of the last entry is client-controlled, the last entry is what
 * the trusted proxy appended.
 *
 *   SPOOF-ROTATING-FIRST-ENTRY   rotating a client-supplied first X-Forwarded-For entry never gives a fresh bucket: one
 *                                real address spraying accounts is refused after 30 failures whatever it forges
 *   SPOOF-MANY-ENTRIES           a long forged chain does not move the key either
 *   NO-HEADER                    no X-Forwarded-For: keyed on the socket address, limited the same way
 *   WINDOW-RESETS                after the 15-minute window the address is served again
 *   PAIR-LIMIT                   one address guessing one account: the 6th failure is refused; that address can still
 *                                sign in to OTHER accounts, and other addresses can still try this one
 *   SUCCESS-CLEARS-PAIR          a successful sign-in clears that (account, address) failure count
 *   SHARED-PUBLIC-IP             20 different users behind ONE public address (office / carrier NAT) sign in within
 *                                one minute, half after a typo (30 requests, the per-address cap): every one succeeds
 *   SUCCESSES-NOT-COUNTED        29 successful sign-ins in a minute from one address: none refused by the failure limits
 *   DISTRIBUTED-GUESSING         10 failures against one account from 10 different addresses: an 11th NEW address is
 *                                refused (no address reached its own limit)
 *   NO-LOCKOUT-FROM-KNOWN-SOURCE meanwhile the real user, from an address it has signed in from before, still signs in:
 *                                the attacker cannot lock the user out
 *   NEUTRAL                      401s are identical for an unknown email and a wrong password; the 429 is identical for
 *                                an existing and a non-existent account and names neither
 *   EMAIL-NORMALISED             case and surrounding spaces cannot be varied around the account limit
 *   CLIENT-PORTAL-SEPARATE       client-portal sign-in has its own limits: failures there never hold a staff/Guard account
 *   RESET-CLEARS-ACCOUNT         a completed password reset clears the account's failure counters (and the real
 *                                AccountRecoveryService calls it)
 *   NO-ADDRESS-HELD              the limiter keeps only SHA-256 keys: no email address or IP in memory
 *   FORGOT-PASSWORD-UNAFFECTED   forgot-password is never held by sign-in failures (per-address rate only)
 *   REGISTRATION                 registration keeps 3 per minute per address, whatever the client forges
 *   PASSWORD-RESET               reset and forgot keep working and keep their per-address limits
 *   OPERATIONAL-UNTHROTTLED      an ordinary API route is never rate limited by the auth policy
 *   NO-RAW-HEADER-IN-SRC         no file in src/ reads X-Forwarded-For directly (the one client-IP rule), except the
 *                                admin-only, read-only diagnostic that displays it for the staging verification gate
 *   CLIENT-IP-RESOLVER           resolveClientIp: req.ip, IPv4-mapped IPv6 reduced, nothing → null
 *
 * No database. Every address is from the documentation ranges (RFC 5737).
 */
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { AccountRecoveryController } from '../src/auth/account-recovery.controller';
import { AccountRecoveryService } from '../src/auth/account-recovery.service';
import { AUTH_THROTTLERS, AuthThrottlerGuard, LOGIN_REQUESTS_PER_MINUTE } from '../src/auth/auth-throttler.guard';
import { LOGIN_LIMITED_MESSAGE, LOGIN_LIMITS, LoginAttemptLimiter } from '../src/auth/login-attempt-limiter';
import { resolveClientIp } from '../src/common/http/client-ip';

@Controller('operational-test')
class OperationalTestController {
  @Get()
  get() {
    return { ok: true };
  }
}

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

/** Accounts that exist, with their password. Everything else is an unknown email (the same 401). */
const ACCOUNTS: Record<string, string> = { 'victim@example.test': 'right-password', 'pair@example.test': 'right-password' };
for (let i = 0; i < 40; i += 1) ACCOUNTS[`colleague${i}@example.test`] = 'right-password';

async function main() {
  let resets = 0;
  const authService = {
    register: async () => ({ ok: true }),
    login: async (dto: { email: string; password: string }) => {
      if (ACCOUNTS[String(dto.email).trim().toLowerCase()] === dto.password) return { accessToken: 'test-token' };
      throw new UnauthorizedException('Invalid credentials');
    },
    clientLogin: async () => { throw new UnauthorizedException('Invalid credentials'); },
  };
  const recoveryService = {
    forgotPassword: async () => ({ message: 'If an account exists, we have sent a link.' }),
    resetPassword: async () => { resets += 1; return { message: 'Password updated.' }; },
    verifyEmail: async () => ({ message: 'Verified.' }),
    resendVerification: async () => ({ message: 'Sent.' }),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot(AUTH_THROTTLERS)],
    controllers: [AuthController, AccountRecoveryController, OperationalTestController],
    providers: [
      { provide: AuthService, useValue: authService },
      { provide: AccountRecoveryService, useValue: recoveryService },
      AuthThrottlerGuard,
      LoginAttemptLimiter,
    ],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const limiter = moduleRef.get(LoginAttemptLimiter);
  const originalNow = Date.now;
  let clock = 0;
  Date.now = () => originalNow() + clock;
  const advance = (ms: number) => { clock += ms; };
  const freshWindow = () => advance(LOGIN_LIMITS.windowMs + 61_000);

  /** `forged` is what the client wrote; `edge` is what the trusted proxy appended (undefined: no proxy, no header). */
  const post = async (path: string, body: unknown, edge?: string, forged: string[] = []) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(edge || forged.length ? { 'x-forwarded-for': [...forged, ...(edge ? [edge] : [])].join(', ') } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };
  const wrong = (email: string) => ({ email, password: 'wrong-password' });
  const right = (email: string) => ({ email, password: 'right-password' });
  const login = (body: unknown, edge?: string, forged: string[] = []) => post('/auth/login', body, edge, forged);

  try {
    await test('SPOOF-ROTATING-FIRST-ENTRY', async () => {
      for (let attempt = 0; attempt < LOGIN_LIMITS.sourceFailures; attempt += 1) {
        const res = await login(wrong(`spoof${attempt}@example.test`), '198.51.100.10', [`203.0.113.${attempt}`]);
        assert.equal(res.status, 401, `attempt ${attempt + 1} is an ordinary failed login`);
      }
      const limited = await login(wrong('spoof99@example.test'), '198.51.100.10', ['203.0.113.250']);
      assert.equal(limited.status, 429, 'a fresh forged first entry does not reset the limit');
    });

    await test('SPOOF-MANY-ENTRIES', async () => {
      const forged = Array.from({ length: 20 }, (_, i) => `192.0.2.${i + 1}`);
      assert.equal((await login(wrong('chain@example.test'), '198.51.100.10', forged)).status, 429, 'still the appended address');
    });

    await test('NO-HEADER', async () => {
      freshWindow();
      for (let attempt = 0; attempt < LOGIN_LIMITS.sourceFailures; attempt += 1) {
        if (attempt === LOGIN_REQUESTS_PER_MINUTE - 1) advance(61_000); // stay under the request-rate cap
        assert.equal((await login(wrong(`direct${attempt}@example.test`))).status, 401);
      }
      assert.equal((await login(wrong('direct99@example.test'))).status, 429);
    });

    await test('WINDOW-RESETS', async () => {
      freshWindow();
      assert.equal((await login(wrong('later@example.test'), '198.51.100.10')).status, 401);
      assert.equal((await login(wrong('later@example.test'))).status, 401);
    });

    await test('PAIR-LIMIT', async () => {
      freshWindow();
      for (let attempt = 0; attempt < LOGIN_LIMITS.pairFailures; attempt += 1) {
        assert.equal((await login(wrong('pair@example.test'), '198.51.100.20')).status, 401);
      }
      assert.equal((await login(wrong('pair@example.test'), '198.51.100.20')).status, 429, 'the 6th guess from that address');
      assert.equal((await login(right('pair@example.test'), '198.51.100.20')).status, 429, 'even with the right password: no oracle');
      assert.equal((await login(right('colleague0@example.test'), '198.51.100.20')).status, 201, 'other accounts from that address');
      assert.equal((await login(right('pair@example.test'), '198.51.100.21')).status, 201, 'the account from another address');
    });

    await test('SUCCESS-CLEARS-PAIR', async () => {
      freshWindow();
      for (let i = 0; i < LOGIN_LIMITS.pairFailures - 1; i += 1) assert.equal((await login(wrong('pair@example.test'), '198.51.100.22')).status, 401);
      assert.equal((await login(right('pair@example.test'), '198.51.100.22')).status, 201);
      for (let i = 0; i < LOGIN_LIMITS.pairFailures - 1; i += 1) assert.equal((await login(wrong('pair@example.test'), '198.51.100.22')).status, 401);
      assert.equal((await login(right('pair@example.test'), '198.51.100.22')).status, 201, 'the count started again after the success');
    });

    await test('SHARED-PUBLIC-IP', async () => {
      freshWindow();
      // A whole shift signing in at once from one office / carrier address, within ONE minute (the request-rate window):
      // 20 people, half of them mistyping first: 30 requests, exactly the per-address request cap, every one served.
      const office = '198.51.100.30';
      let requests = 0;
      const send = (body: unknown) => { requests += 1; return login(body, office); };
      for (let i = 0; i < 20; i += 1) {
        const email = `colleague${i}@example.test`;
        if (i % 2 === 0) assert.equal((await send(wrong(email))).status, 401, `${email}: a typo`);
        const ok = await send(right(email));
        assert.equal(ok.status, 201, `${email} signs in from the shared address: ${ok.text} after ${requests} requests`);
      }
      assert.equal(requests, LOGIN_REQUESTS_PER_MINUTE);
    });

    await test('SUCCESSES-NOT-COUNTED', async () => {
      freshWindow();
      for (let i = 0; i < LOGIN_REQUESTS_PER_MINUTE - 1; i += 1) {
        assert.equal((await login(right(`colleague${i}@example.test`), '198.51.100.31')).status, 201);
      }
    });

    let attackLimited = '';
    await test('DISTRIBUTED-GUESSING', async () => {
      freshWindow();
      // The real user signs in from home first: that address becomes known for the account.
      assert.equal((await login(right('victim@example.test'), '198.51.100.40')).status, 201);
      for (let attempt = 0; attempt < LOGIN_LIMITS.accountFailures; attempt += 1) {
        const res = await login(wrong('victim@example.test'), `198.51.100.${100 + attempt}`);
        assert.equal(res.status, 401, `guess ${attempt + 1} from its own address is an ordinary failure`);
      }
      const eleventh = await login(wrong('victim@example.test'), '198.51.100.200');
      assert.equal(eleventh.status, 429, 'the account limit holds across addresses');
      attackLimited = eleventh.text;
      assert.equal((await login(right('victim@example.test'), '198.51.100.201')).status, 429, 'a new address with the right password: no oracle');
      assert.equal((await login(wrong('bystander@example.test'), '198.51.100.202')).status, 401, 'another account is not affected');
    });

    await test('NO-LOCKOUT-FROM-KNOWN-SOURCE', async () => {
      assert.equal((await login(right('victim@example.test'), '198.51.100.40')).status, 201, 'the user still signs in from home');
      freshWindow();
      assert.equal((await login(right('victim@example.test'), '198.51.100.203')).status, 201, 'and from anywhere once the window passes');
    });

    await test('NEUTRAL', async () => {
      freshWindow();
      const unknown = await login(wrong('nobody-here@example.test'), '198.51.100.50');
      const known = await login(wrong('victim@example.test'), '198.51.100.51');
      assert.equal(unknown.status, 401);
      assert.equal(unknown.text, known.text, 'an unknown email and a wrong password are indistinguishable');
      for (let attempt = 1; attempt < LOGIN_LIMITS.accountFailures; attempt += 1) {
        await login(wrong('nobody-here@example.test'), `198.51.100.${120 + attempt}`);
      }
      const ghostLimited = await login(wrong('nobody-here@example.test'), '198.51.100.250');
      assert.equal(ghostLimited.status, 429, 'a non-existent account is limited exactly like a real one');
      assert.equal(ghostLimited.text, attackLimited, 'the same refusal for an existing and a non-existent account');
      const body = JSON.parse(ghostLimited.text);
      assert.equal(body.message, LOGIN_LIMITED_MESSAGE);
      assert.ok(!/nobody|victim|exist|account .* (not|does)/i.test(ghostLimited.text), 'names neither the account nor whether it exists');
    });

    await test('EMAIL-NORMALISED', async () => {
      freshWindow();
      const variants = ['norm@example.test', ' Norm@Example.test ', 'NORM@EXAMPLE.TEST'];
      for (let attempt = 0; attempt < LOGIN_LIMITS.accountFailures; attempt += 1) {
        assert.equal((await login(wrong(variants[attempt % 3]), `198.51.100.${60 + attempt}`)).status, 401);
      }
      assert.equal((await login(wrong('nOrM@example.TEST'), '198.51.100.90')).status, 429);
    });

    await test('CLIENT-PORTAL-SEPARATE', async () => {
      freshWindow();
      for (let attempt = 0; attempt < LOGIN_LIMITS.accountFailures; attempt += 1) {
        assert.equal((await post('/auth/client-login', wrong('victim@example.test'), `192.0.2.${10 + attempt}`)).status, 401);
      }
      assert.equal((await post('/auth/client-login', wrong('victim@example.test'), '192.0.2.99')).status, 429, 'client portal: account limit');
      assert.equal((await login(right('victim@example.test'), '192.0.2.98')).status, 201, 'the staff/Guard account is not held');
      for (let attempt = 0; attempt < LOGIN_LIMITS.pairFailures; attempt += 1) await post('/auth/client-login', wrong('c2@example.test'), '192.0.2.120');
      assert.equal((await post('/auth/client-login', wrong('c2@example.test'), '192.0.2.120')).status, 429, 'client portal: pair limit');
    });

    await test('RESET-CLEARS-ACCOUNT', async () => {
      freshWindow();
      for (let attempt = 0; attempt < LOGIN_LIMITS.accountFailures; attempt += 1) await login(wrong('victim@example.test'), `203.0.113.${10 + attempt}`);
      assert.equal((await login(right('victim@example.test'), '203.0.113.200')).status, 429, 'held for new addresses');
      limiter.clearAccount('user', ' VICTIM@example.test');
      assert.equal((await login(right('victim@example.test'), '203.0.113.200')).status, 201, 'the reset released the account');
      const recovery = readFileSync(join(__dirname, '..', 'src', 'auth', 'account-recovery.service.ts'), 'utf8');
      const reset = recovery.slice(recovery.indexOf('async resetPassword('), recovery.indexOf('async resetPassword(') + 2500);
      assert.match(reset, /this\.loginLimiter\?\.clearAccount\('user', outcome\.email\)/, 'the real reset clears the counters');
      assert.ok(reset.indexOf("throw new BadRequestException(INVALID_RESET_LINK)") < reset.indexOf('clearAccount'), 'only after a successful reset');
    });

    await test('NO-ADDRESS-HELD', () => {
      const dump = JSON.stringify(Object.entries(limiter as any).map(([k, v]) =>
        [k, v instanceof Map ? [...v.entries()].map(([a, b]) => [a, b instanceof Map ? [...b.keys()] : b]) : null]));
      assert.ok(!/@|example\.test|198\.51\.100|203\.0\.113|192\.0\.2/.test(dump), 'only hashes');
    });

    await test('FORGOT-PASSWORD-UNAFFECTED', async () => {
      freshWindow();
      for (let attempt = 0; attempt < LOGIN_LIMITS.accountFailures + 2; attempt += 1) await login(wrong('scope@example.test'), `198.51.100.${150 + attempt}`);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.equal((await post('/auth/forgot-password', { email: 'scope@example.test' }, `198.51.100.${170 + attempt}`)).status, 202,
          'a held account can always ask for a reset link');
      }
    });

    await test('REGISTRATION', async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.equal((await post('/auth/register', {}, '198.51.100.13', [`203.0.113.${attempt}`])).status, 201);
      }
      assert.equal((await post('/auth/register', {}, '198.51.100.13', ['203.0.113.99'])).status, 429);
    });

    await test('PASSWORD-RESET', async () => {
      freshWindow();
      const reset = { token: 'a'.repeat(43), newPassword: 'A-new-strong-pass-1' };
      assert.equal((await post('/auth/reset-password', reset, '198.51.100.14')).status, 200);
      assert.equal(resets, 1, 'a legitimate reset reaches the service');
      for (let attempt = 1; attempt < 10; attempt += 1) {
        assert.equal((await post('/auth/reset-password', reset, '198.51.100.14', [`203.0.113.${attempt}`])).status, 200);
      }
      assert.equal((await post('/auth/reset-password', reset, '198.51.100.14', ['203.0.113.200'])).status, 429);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.equal((await post('/auth/forgot-password', { email: 'reset@example.test' }, '198.51.100.15', [`203.0.113.${attempt}`])).status, 202);
      }
      assert.equal((await post('/auth/forgot-password', { email: 'reset@example.test' }, '198.51.100.15', ['203.0.113.9'])).status, 429);
    });

    await test('OPERATIONAL-UNTHROTTLED', async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const res = await fetch(`${baseUrl}/operational-test`, { headers: { 'x-forwarded-for': '198.51.100.10' } });
        assert.equal(res.status, 200, 'the auth policy never limits an operational API');
      }
    });

    await test('NO-RAW-HEADER-IN-SRC', () => {
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (/\.ts$/.test(name)) {
            const code = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
            if (/x-forwarded-for|forwardedFor|\.ips\b/i.test(code)) offenders.push(full);
          }
        }
      };
      walk(join(__dirname, '..', 'src'));
      // One reviewed exception: the admin-only diagnostic that DISPLAYS the chain to the administrator who sent it (the
      // staging verification gate). It must stay admin-only, read-only, and used by nothing else.
      const diagnostic = join(__dirname, '..', 'src', 'common', 'http', 'client-ip-diagnostics.controller.ts');
      assert.deepEqual(offenders, [diagnostic], 'only resolveClientIp (req.ip under trust proxy) decides the client address');
      const code = readFileSync(diagnostic, 'utf8');
      assert.match(code, /@UseGuards\(JwtAuthGuard, RolesGuard\)\r?\n@Roles\(UserRole\.ADMIN\)\r?\nexport class ClientIpDiagnosticsController/, 'admin only');
      assert.doesNotMatch(code, /@(Post|Put|Patch|Delete)\(/, 'read only');
      const users: string[] = [];
      const find = (dir: string) => { for (const name of readdirSync(dir)) { const full = join(dir, name); if (statSync(full).isDirectory()) find(full); else if (full !== diagnostic && /client-ip-diagnostics/.test(readFileSync(full, 'utf8'))) users.push(name); } };
      find(join(__dirname, '..', 'src'));
      assert.deepEqual(users, ['auth.module.ts'], 'only registered, never called');
    });

    await test('CLIENT-IP-RESOLVER', () => {
      assert.equal(resolveClientIp({ ip: '198.51.100.7' }), '198.51.100.7');
      assert.equal(resolveClientIp({ ip: '::ffff:198.51.100.7' }), '198.51.100.7');
      assert.equal(resolveClientIp({ ip: '2001:db8::1' }), '2001:db8::1');
      assert.equal(resolveClientIp({ socket: { remoteAddress: '192.0.2.4' } }), '192.0.2.4');
      assert.equal(resolveClientIp({}), null);
      assert.equal(resolveClientIp(undefined), null);
    });

    console.log(JSON.stringify({ event: 'auth_rate_limit_tests_passed', tests: passed }));
  } finally {
    Date.now = originalNow;
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
