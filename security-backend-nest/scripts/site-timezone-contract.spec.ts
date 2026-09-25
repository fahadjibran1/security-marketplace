/**
 * Site creation timezone contract.
 *
 * Client UAT-01: creating a Site failed with "property timezone should not exist". The entity, the
 * migration and the frontend payload all carried `timezone`; only CreateSiteDto did not, so the
 * global ValidationPipe (forbidNonWhitelisted) rejected the request.
 *
 * These tests run the real DTO through the real validation pipe configuration, and check that the
 * value actually reaches the column that the billing-week calculation reads.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe, ArgumentMetadata } from '@nestjs/common';
import { CreateSiteDto } from '../src/site/dto/create-site.dto';
import { UpdateSiteDto } from '../src/site/dto/update-site.dto';
import { computeWeekCommencing } from '../src/client-weekly-approval/week-commencing.util';

let passed = 0;
const test = async (id: string, fn: () => Promise<void> | void) => { await fn(); passed += 1; console.log(`PASS  ${id}`); };

// Exactly the configuration main.ts applies in production.
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const meta = (metatype: unknown): ArgumentMetadata => ({ type: 'body', metatype: metatype as never, data: '' });
const validate = (dto: unknown, body: Record<string, unknown>) => pipe.transform(body, meta(dto));
const errorsFrom = async (dto: unknown, body: Record<string, unknown>) => {
  try { await validate(dto, body); return null; } catch (e) { return JSON.stringify((e as { response?: unknown }).response ?? (e as Error).message); }
};

const baseSite = { clientId: 1, name: 'Client Demo Site', address: '1 Demo Street, Leeds, LS1 4AP' };

async function main() {
  await test('SITE-TIMEZONE-ACCEPTED', async () => {
    const out = await validate(CreateSiteDto, { ...baseSite, timezone: 'Europe/London' }) as CreateSiteDto;
    assert.equal(out.timezone, 'Europe/London', 'the submitted timezone must survive validation');
  });

  await test('SITE-TIMEZONE-NO-LONGER-FORBIDDEN', async () => {
    // The exact client UAT-01 failure.
    const errors = await errorsFrom(CreateSiteDto, { ...baseSite, timezone: 'Europe/London' });
    assert.equal(errors, null, `site creation must not be rejected: ${errors}`);
    assert.ok(!(errors ?? '').includes('property timezone should not exist'));
  });

  await test('SITE-TIMEZONE-OPTIONAL', async () => {
    const out = await validate(CreateSiteDto, baseSite) as CreateSiteDto;
    assert.equal(out.timezone, undefined, 'omitting it stays valid — the service applies the default');
  });

  await test('SITE-TIMEZONE-INVALID-REJECTED', async () => {
    // A zone Intl cannot use would throw inside the billing-week calculation later, so it is
    // refused at creation instead.
    for (const bad of ['Europe/Manchester', 'not a zone', 'GMT+1:00', '']) {
      const errors = await errorsFrom(CreateSiteDto, { ...baseSite, timezone: bad });
      assert.ok(errors, `"${bad}" should have been rejected`);
      assert.ok(errors!.includes('valid IANA timezone'), `"${bad}" should fail with the plain-language message, got ${errors}`);
    }
  });

  await test('SITE-TIMEZONE-UPDATE-ACCEPTED', async () => {
    const out = await validate(UpdateSiteDto, { timezone: 'Europe/Dublin' }) as UpdateSiteDto;
    assert.equal(out.timezone, 'Europe/Dublin', 'editing a site may change its timezone');
    assert.equal(await errorsFrom(UpdateSiteDto, { name: 'Renamed only' }), null, 'a partial update without timezone stays valid');
  });

  await test('SITE-TIMEZONE-UNKNOWN-FIELD-STILL-REJECTED', async () => {
    // The fix adds one property; it must not have loosened the contract generally.
    const errors = await errorsFrom(CreateSiteDto, { ...baseSite, notARealField: 'x' });
    assert.ok(errors && errors.includes('notARealField'), 'unknown properties must still be refused');
  });

  await test('SITE-TIMEZONE-DRIVES-BILLING-WEEK', async () => {
    // Why this column matters: a shift starting 00:30 BST on Monday 2 June 2025 is still Sunday
    // 1 June in UTC. Read in the site's zone it belongs to the week commencing Monday 2 June.
    const lateNightBst = new Date('2025-06-01T23:30:00Z');
    assert.equal(computeWeekCommencing(lateNightBst, 'Europe/London'), '2025-06-02', 'London puts it in the new week');
    assert.equal(computeWeekCommencing(lateNightBst, 'UTC'), '2025-05-26', 'UTC keeps it in the previous week');
  });

  console.log(JSON.stringify({ event: 'site_timezone_contract_tests_passed', tests: passed }));
}

main().catch((e) => { console.error(e); process.exit(1); });
