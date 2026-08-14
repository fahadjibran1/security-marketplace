import { Controller, Get, INestApplication, Post, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';

@Controller('operational-test')
class OperationalTestController {
  @Get()
  get() {
    return { ok: true };
  }
}

async function request(baseUrl: string, path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
}

async function main() {
  let successfulLogins = 0;
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

  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 6 }])],
    controllers: [AuthController, OperationalTestController],
    providers: [{ provide: AuthService, useValue: authService }],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const originalNow = Date.now;

  try {
    const failedBodies: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await request(baseUrl, '/auth/login', {
        method: 'POST',
        headers: { 'x-forwarded-for': '198.51.100.10' },
        body: JSON.stringify({ email: attempt === 0 ? 'known@example.test' : 'unknown@example.test', password: 'wrong-password' }),
      });
      if (response.status !== 401) throw new Error(`Expected failed login 401, received ${response.status}`);
      failedBodies.push(await response.text());
    }
    if (failedBodies[0] !== failedBodies[1]) throw new Error('Login failures expose account enumeration details');

    const limited = await request(baseUrl, '/auth/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.10' },
      body: JSON.stringify({ email: 'unknown@example.test', password: 'wrong-password' }),
    });
    if (limited.status !== 429) throw new Error(`Expected rate limit 429, received ${limited.status}`);

    Date.now = () => originalNow() + 60_001;
    const reset = await request(baseUrl, '/auth/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.10' },
      body: JSON.stringify({ email: 'unknown@example.test', password: 'wrong-password' }),
    });
    if (reset.status !== 401) throw new Error(`Expected reset window to accept request, received ${reset.status}`);
    Date.now = originalNow;

    const successful = await request(baseUrl, '/auth/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.11' },
      body: JSON.stringify({ email: 'valid@example.test', password: 'valid-password' }),
    });
    if (successful.status !== 201 || successfulLogins !== 1) throw new Error('Normal successful authentication failed');

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const operational = await request(baseUrl, '/operational-test', { headers: { 'x-forwarded-for': '198.51.100.10' } });
      if (operational.status !== 200) throw new Error('Auth policy unintentionally rate-limited an operational API');
    }

    console.log(JSON.stringify({ event: 'auth_rate_limit_tests_passed', tests: 5 }));
  } finally {
    Date.now = originalNow;
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
