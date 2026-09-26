/**
 * Daily log request validation.
 *
 * The Log Book audit found `CreateDailyLogDto.message` carried `@IsString()` and no upper bound,
 * so an unbounded body could be written straight into the `text` column of an append-only table
 * that has no delete path. These tests run the real DTO through the exact ValidationPipe
 * configuration main.ts applies in production.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import {
  CreateDailyLogDto,
  DAILY_LOG_MESSAGE_MAX_LENGTH,
} from '../src/daily-log/dto/create-daily-log.dto';
import { DailyLogType } from '../src/daily-log/entities/daily-log.entity';

let passed = 0;
const test = async (id: string, fn: () => Promise<void> | void) => {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
};

// Exactly the configuration main.ts applies in production.
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const meta = (metatype: unknown): ArgumentMetadata => ({ type: 'body', metatype: metatype as never, data: '' });
const validate = (body: Record<string, unknown>) => pipe.transform(body, meta(CreateDailyLogDto));
const errorsFrom = async (body: Record<string, unknown>) => {
  try {
    await validate(body);
    return null;
  } catch (error) {
    return JSON.stringify((error as { response?: unknown }).response ?? (error as Error).message);
  }
};

const message = (length: number) => 'x'.repeat(length);

async function main() {
  await test('DAILY-LOG-MAX-LENGTH-IS-4000', () => {
    assert.equal(DAILY_LOG_MESSAGE_MAX_LENGTH, 4000);
  });

  await test('DAILY-LOG-ACCEPTS-A-NORMAL-ENTRY', async () => {
    const out = (await validate({
      shiftId: 1,
      message: 'Site secure. Perimeter checked, all doors locked, no issues to report.',
    })) as CreateDailyLogDto;
    assert.equal(out.shiftId, 1);
    assert.ok(out.message.startsWith('Site secure.'), 'the narrative must survive validation intact');
  });

  await test('DAILY-LOG-ACCEPTS-EXACTLY-THE-LIMIT', async () => {
    const errors = await errorsFrom({ shiftId: 1, message: message(DAILY_LOG_MESSAGE_MAX_LENGTH) });
    assert.equal(errors, null, `the bound must be inclusive: ${errors}`);
  });

  await test('DAILY-LOG-REJECTS-OVER-THE-LIMIT', async () => {
    const errors = await errorsFrom({ shiftId: 1, message: message(DAILY_LOG_MESSAGE_MAX_LENGTH + 1) });
    assert.notEqual(errors, null, 'one character past the bound must be rejected');
    assert.ok(/message/.test(String(errors)), `the error must name the field: ${errors}`);
  });

  await test('DAILY-LOG-STILL-REJECTS-A-MISSING-MESSAGE', async () => {
    assert.notEqual(await errorsFrom({ shiftId: 1 }), null);
    assert.notEqual(await errorsFrom({ shiftId: 1, message: 42 }), null, 'a non-string is still refused');
  });

  await test('DAILY-LOG-TYPE-CONTRACT-UNCHANGED', async () => {
    // W1 changed only the length bound. The optional logType and the unknown-property rejection
    // that the whole API depends on must behave exactly as before.
    const out = (await validate({
      shiftId: 1,
      message: 'Check call completed.',
      logType: DailyLogType.CHECK_CALL,
    })) as CreateDailyLogDto;
    assert.equal(out.logType, DailyLogType.CHECK_CALL);

    const omitted = (await validate({ shiftId: 1, message: 'No type supplied.' })) as CreateDailyLogDto;
    assert.equal(omitted.logType, undefined, 'the service, not the DTO, applies the default');

    assert.notEqual(await errorsFrom({ shiftId: 1, message: 'x', logType: 'log_book' }), null,
      'log_book is not a persisted type until Migration 59 and must still be refused');
    assert.notEqual(await errorsFrom({ shiftId: 1, message: 'x', unexpected: true }), null,
      'forbidNonWhitelisted still rejects unknown properties');
  });

  console.log(`\n${passed} daily log validation checks passed`);
}

main().catch((error) => {
  console.error(`\nFAIL  ${error?.message || error}`);
  process.exit(1);
});
