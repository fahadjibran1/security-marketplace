import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { strict as assert } from 'assert';
import { AddressInfo } from 'net';
import { configureHttpSecurity } from '../src/config/http-security';
import { getCorsOrigins, getTrustProxySetting, isSwaggerEnabled } from '../src/config/runtime-env';

@Controller()
class HeaderTestController {
  @Get('api/test') api() { return { ok: true }; }
  @Get('health/live') live() { return { ok: true }; }
  @Get('health/ready') ready() { return { ok: true }; }
  @Get('api-docs') swagger() { return '<html>swagger</html>'; }
}

@Module({ controllers: [HeaderTestController] })
class HeaderTestModule {}

async function startApp(env: NodeJS.ProcessEnv) {
  const app = await NestFactory.create(HeaderTestModule, { logger: false });
  app.getHttpAdapter().getInstance().set('trust proxy', getTrustProxySetting(env));
  configureHttpSecurity(app, env);
  app.enableCors({ origin: getCorsOrigins(env), credentials: true });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function main() {
  const approvedOrigin = 'https://portal.s4.example';
  const production = await startApp({
    NODE_ENV: 'production', CORS_ORIGIN: approvedOrigin, TRUST_PROXY: '1', ENABLE_SWAGGER: 'false',
  });

  try {
    const normal = await fetch(`${production.baseUrl}/api/test`);
    const hsts = normal.headers.get('strict-transport-security') ?? '';
    assert.ok(hsts, 'production responses must contain HSTS');
    assert.ok(Number(/max-age=(\d+)/i.exec(hsts)?.[1]) >= 31_536_000, 'HSTS max-age must be at least one year');
    assert.ok(!/preload/i.test(hsts), 'HSTS preload must remain disabled');
    assert.ok(!/includeSubDomains/i.test(hsts), 'HSTS must not cover unverified subdomains');
    assert.equal(normal.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(normal.headers.get('x-powered-by'), null);
    assert.ok(normal.headers.get('x-frame-options') || /frame-ancestors/.test(normal.headers.get('content-security-policy') ?? ''));
    assert.ok(normal.headers.get('referrer-policy'));
    const csp = normal.headers.get('content-security-policy') ?? '';
    assert.ok(csp && !csp.includes('*') && !csp.includes("'unsafe-eval'") && !csp.includes("'unsafe-inline'"));
    assert.equal(normal.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(normal.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(normal.headers.get('origin-agent-cluster'), '?1');
    assert.equal(normal.headers.get('x-dns-prefetch-control'), 'off');
    assert.equal(normal.headers.get('x-download-options'), 'noopen');
    assert.equal(normal.headers.get('x-permitted-cross-domain-policies'), 'none');
    assert.equal(normal.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
    assert.equal(normal.status, 200, 'normal API response must remain usable');

    for (const path of ['/health/live', '/health/ready']) {
      const response = await fetch(`${production.baseUrl}${path}`);
      assert.ok(response.headers.get('strict-transport-security'), `${path} must contain security headers`);
    }

    const approved = await fetch(`${production.baseUrl}/api/test`, { headers: { Origin: approvedOrigin } });
    assert.equal(approved.headers.get('access-control-allow-origin'), approvedOrigin);
    assert.equal(approved.headers.get('access-control-allow-credentials'), 'true');
    const rejected = await fetch(`${production.baseUrl}/api/test`, { headers: { Origin: 'https://attacker.example' } });
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);
    assert.equal(getTrustProxySetting({ NODE_ENV: 'production', TRUST_PROXY: '1' }), 1);
  } finally {
    await production.app.close();
  }

  const development = await startApp({ NODE_ENV: 'development', ENABLE_SWAGGER: 'true' });
  try {
    const swagger = await fetch(`${development.baseUrl}/api-docs`);
    assert.equal(swagger.status, 200);
    assert.equal(swagger.headers.get('strict-transport-security'), null);
    assert.equal(swagger.headers.get('content-security-policy'), null);
    assert.equal(isSwaggerEnabled({ NODE_ENV: 'development', ENABLE_SWAGGER: 'true' }), true);
  } finally {
    await development.app.close();
  }

  console.log(JSON.stringify({ event: 'http_security_headers_tests_passed', tests: 23 }));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
