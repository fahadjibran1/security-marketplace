/**
 * Authentication rate limits (SEC-PUBLIC-02), over real HTTP against the real AuthController and AccountRecoveryController
 * with the production `trust proxy` setting (1 hop: Render's edge proxy).
 *
 * In production the proxy APPENDS the address it received the connection from to whatever X-Forwarded-For the client
 * sent. Here the test plays both parts: everything left of the last entry is client-controlled, the last entry is what
 * the trusted proxy appended.
 *
 *   SPOOF-ROTATING-FIRST-ENTRY   rotating a client-supplied first X-Forwarded-For entry no longer gives each request a
 *                                fresh bucket: the 7th login from one real address is 429 (it was the bypass)
 *   SPOOF-MANY-ENTRIES           a long forged chain does not move the key either
 *   NO-HEADER                    a request with no X-Forwarded-For is keyed on the socket address and limited the same way
 *   WINDOW-RESETS                after the window the same address is served again
 *   LEGITIMATE-LOGIN             a correct login from a fresh address succeeds
 *   ACCOUNT-LIMIT                10 attempts per 15 minutes against ONE account from 11 different addresses: the 11th is
 *                                429 even though no address reached its own limit; another account is unaffected; the
 *                                email is normalised (case / spaces) so it cannot be varied around the limit
 *   ACCOUNT-LIMIT-SCOPE          the per-account limit applies to sign-in only, never to recovery
 *   CLIENT-PORTAL                client-login keeps its per-address limit and has the per-account limit too
 *   REGISTRATION                 registration keeps 3 per minute per address, whatever the client forges
 *   PASSWORD-RESET               forgot-password and reset-password keep working and keep their per-address limits
 *   OPERATIONAL-UNTHROTTLED      an ordinary API route is never rate limited by the auth policy
 *   NO-RAW-HEADER-IN-SRC         no file in src/ reads X-Forwarded-For directly (the one client-IP rule)
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
import { ACCOUNT_THROTTLE_LIMIT, AUTH_THROTTLERS, AuthThrottlerGuard } from '../src/auth/auth-throttler.guard';
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

async function main() {
  let successfulLogins = 0;
  let resets = 0;
  const authService = {
    register: async () => ({ ok: true }),
    login: async (dto: { email: string }) => {
      if (dto.email === 'valid@example.test') {
        successfulLogins += 1;
        return { accessToken: 'test-token' };
      }
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
    ],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const originalNow = Date.now;
  let clock = 0;
  Date.now = () => originalNow() + clock;
  const advance = (ms: number) => { clock += ms; };

  /** `forged` is what the client wrote; `edge` is what the trusted proxy appended (undefined: no proxy, no header). */
  const post = (path: string, body: unknown, edge?: string, forged: string[] = []) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(edge || forged.length ? { 'x-forwarded-for': [...forged, ...(edge ? [edge] : [])].join(', ') } : {}),
      },
      body: JSON.stringify(body),
    });
  const wrong = (email: string) => ({ email, password: 'wrong-password' });

  try {
    await test('SPOOF-ROTATING-FIRST-ENTRY', async () => {
      const bodies: string[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const res = await post('/auth/login', wrong(`spoof${attempt}@example.test`), '198.51.100.10', [`203.0.113.${attempt}`]);
        assert.equal(res.status, 401, `attempt ${attempt + 1} is an ordinary failed login`);
        bodies.push(await res.text());
      }
      assert.equal(bodies[0], bodies[1], 'failed logins are indistinguishable (no account enumeration)');
      const limited = await post('/auth/login', wrong('spoof99@example.test'), '198.51.100.10', ['203.0.113.250']);
      assert.equal(limited.status, 429, 'a fresh forged first entry no longer resets the limit');
    });

    await test('SPOOF-MANY-ENTRIES', async () => {
      const forged = Array.from({ length: 20 }, (_, i) => `192.0.2.${i + 1}`);
      const res = await post('/auth/login', wrong('chain@example.test'), '198.51.100.10', forged);
      assert.equal(res.status, 429, 'a forged chain still resolves to the address the proxy appended');
    });

    await test('NO-HEADER', async () => {
      // No proxy hop in the header: Express falls back to the socket address (127.0.0.1 here), one bucket like any other.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        assert.equal((await post('/auth/login', wrong(`direct${attempt}@example.test`))).status, 401);
      }
      assert.equal((await post('/auth/login', wrong('direct99@example.test'))).status, 429);
    });

    await test('WINDOW-RESETS', async () => {
      advance(60_001);
      assert.equal((await post('/auth/login', wrong('later@example.test'), '198.51.100.10')).status, 401);
    });

    await test('LEGITIMATE-LOGIN', async () => {
      const res = await post('/auth/login', { email: 'valid@example.test', password: 'valid-password' }, '198.51.100.11');
      assert.equal(res.status, 201);
      assert.equal(successfulLogins, 1);
    });

    await test('ACCOUNT-LIMIT', async () => {
      advance(16 * 60_000); // every earlier window has expired
      const variants = ['victim@example.test', ' Victim@Example.test ', 'VICTIM@EXAMPLE.TEST'];
      for (let attempt = 0; attempt < ACCOUNT_THROTTLE_LIMIT; attempt += 1) {
        const res = await post('/auth/login', wrong(variants[attempt % variants.length]), `198.51.100.${100 + attempt}`);
        assert.equal(res.status, 401, `attempt ${attempt + 1} from its own address is an ordinary failure`);
      }
      const eleventh = await post('/auth/login', wrong('victim@example.test'), '198.51.100.200');
      assert.equal(eleventh.status, 429, 'the account limit holds across addresses');
      const other = await post('/auth/login', wrong('bystander@example.test'), '198.51.100.201');
      assert.equal(other.status, 401, 'another account is not affected');
      advance(15 * 60_000 + 1);
      const afterWindow = await post('/auth/login', wrong('victim@example.test'), '198.51.100.202');
      assert.equal(afterWindow.status, 401, 'the account limit resets after its window');
    });

    await test('ACCOUNT-LIMIT-SCOPE', async () => {
      advance(16 * 60_000);
      // forgot-password is per-address only (the service limits issuing per account itself, silently).
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const res = await post('/auth/forgot-password', { email: 'scope@example.test' }, `198.51.100.${30 + attempt}`);
        assert.equal(res.status, 202, `forgot-password from new address ${attempt + 1} is accepted`);
      }
    });

    await test('CLIENT-PORTAL', async () => {
      advance(16 * 60_000);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        assert.equal((await post('/auth/client-login', wrong('client@example.test'), '198.51.100.12', [`203.0.113.${attempt}`])).status, 401);
      }
      assert.equal((await post('/auth/client-login', wrong('client@example.test'), '198.51.100.12', ['203.0.113.77'])).status, 429);
      advance(60_001);
      // The 7th request above was refused by the per-address limit before it was counted against the account, so the
      // account has 6 attempts behind it; 4 more from fresh addresses reach the 10, and the next is refused.
      for (let attempt = 0; attempt < ACCOUNT_THROTTLE_LIMIT - 6; attempt += 1) {
        assert.equal((await post('/auth/client-login', wrong('client@example.test'), `198.51.100.${150 + attempt}`)).status, 401);
      }
      assert.equal((await post('/auth/client-login', wrong('client@example.test'), '198.51.100.170')).status, 429, 'per-account');
    });

    await test('REGISTRATION', async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.equal((await post('/auth/register', {}, '198.51.100.13', [`203.0.113.${attempt}`])).status, 201);
      }
      assert.equal((await post('/auth/register', {}, '198.51.100.13', ['203.0.113.99'])).status, 429);
    });

    await test('PASSWORD-RESET', async () => {
      advance(16 * 60_000);
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
      for (let attempt = 0; attempt < 12; attempt += 1) {
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
      assert.deepEqual(offenders, [], 'only resolveClientIp (req.ip under trust proxy) decides the client address');
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
