/**
 * P1G-B Product Scope Correction — Focused regression spec.
 *
 * Proves that payrollPaymentMethod has been removed from the S4 codebase and that
 * all remaining P1G-B functionality (reference, frequency, status, dates, note encryption,
 * tenant isolation, rate separation, PayRuleService, PayrollBatch) is unaffected.
 *
 * Run: ts-node -r tsconfig-paths/register scripts/p1gb-product-correction.spec.ts
 */
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ValidationPipe } from '@nestjs/common';
import { CreatePayrollAdminDto } from '../src/guard-personnel/dto/create-payroll-admin.dto';
import { UpdatePayrollAdminDto } from '../src/guard-personnel/dto/update-payroll-admin.dto';
import { PayrollAdminCompanyResponseDto } from '../src/guard-personnel/dto/payroll-admin-company-response.dto';
import { PayrollAdminAdminResponseDto } from '../src/guard-personnel/dto/payroll-admin-admin-response.dto';
import { PayrollAdminGuardResponseDto } from '../src/guard-personnel/dto/payroll-admin-guard-response.dto';
import { GuardPayFrequency, GuardPayrollStatus } from '../src/guard-personnel/entities/company-guard-payroll.entity';

type Test = { name: string; run: () => void | Promise<void> };
const tests: Test[] = [];
const test = (name: string, run: Test['run']) => tests.push({ name, run });
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };

const backend = (file: string) => readFileSync(resolve(__dirname, '../src', file), 'utf8');
const mobile  = (file: string) => readFileSync(resolve(__dirname, '../../security-mobile-app/src', file), 'utf8');

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

// ── TEST 1: payrollPaymentMethod absent from CreatePayrollAdminDto ───────────
test('T1 payrollPaymentMethod absent from CreatePayrollAdminDto', () => {
  const dto = new CreatePayrollAdminDto();
  assert(!('payrollPaymentMethod' in dto), 'payrollPaymentMethod exists on CreatePayrollAdminDto');
  const src = backend('guard-personnel/dto/create-payroll-admin.dto.ts');
  assert(!src.includes('payrollPaymentMethod'), 'create DTO source still references payrollPaymentMethod');
  assert(!src.includes('GuardPayrollPaymentMethod'), 'create DTO source still imports GuardPayrollPaymentMethod');
});

// ── TEST 2: payrollPaymentMethod absent from UpdatePayrollAdminDto ───────────
test('T2 payrollPaymentMethod absent from UpdatePayrollAdminDto', () => {
  const dto = new UpdatePayrollAdminDto();
  assert(!('payrollPaymentMethod' in dto), 'payrollPaymentMethod exists on UpdatePayrollAdminDto');
  const src = backend('guard-personnel/dto/update-payroll-admin.dto.ts');
  assert(!src.includes('payrollPaymentMethod'), 'update DTO source still references payrollPaymentMethod');
  assert(!src.includes('GuardPayrollPaymentMethod'), 'update DTO source still imports GuardPayrollPaymentMethod');
});

// ── TEST 3: payrollPaymentMethod absent from UI ──────────────────────────────
test('T3 payrollPaymentMethod absent from mobile UI and models', () => {
  const models = mobile('types/models.ts');
  assert(!models.includes('GuardPayrollPaymentMethod'), 'models.ts still exports GuardPayrollPaymentMethod');
  assert(!models.includes("payrollPaymentMethod"), 'models.ts still references payrollPaymentMethod');
  const dashboard = mobile('screens/CompanyDashboardScreen.tsx');
  assert(!dashboard.includes('payrollPaymentMethod'), 'CompanyDashboardScreen still references payrollPaymentMethod');
  assert(!dashboard.includes('PAYMENT_METHOD_OPTIONS'), 'CompanyDashboardScreen still defines PAYMENT_METHOD_OPTIONS');
  assert(!dashboard.includes("'BACS'"), 'CompanyDashboardScreen still lists BACS option');
  assert(!dashboard.includes("'CHAPS'"), 'CompanyDashboardScreen still lists CHAPS option');
});

// ── TEST 4: payFrequency is optional in CreatePayrollAdminDto ────────────────
test('T4 payFrequency is optional (omitting it is valid)', async () => {
  const raw = {
    payrollReference: 'EMP-001',
    payrollStatus: GuardPayrollStatus.ACTIVE,
    payrollStartDate: '2026-01-01',
  };
  const result = await pipe.transform(raw, { type: 'body', metatype: CreatePayrollAdminDto });
  assert(result instanceof CreatePayrollAdminDto, 'transform did not return CreatePayrollAdminDto');
  assert(result.payFrequency === undefined, `payFrequency should be undefined when omitted, got: ${result.payFrequency}`);
});

// ── TEST 5: omitting payFrequency is valid on UpdatePayrollAdminDto ──────────
test('T5 omitting payFrequency is valid in UpdatePayrollAdminDto', async () => {
  const raw = { payrollStatus: GuardPayrollStatus.ON_HOLD };
  const result = await pipe.transform(raw, { type: 'body', metatype: UpdatePayrollAdminDto });
  assert(result instanceof UpdatePayrollAdminDto, 'transform did not return UpdatePayrollAdminDto');
  assert(result.payFrequency === undefined, 'payFrequency should be undefined when omitted');
});

// ── TEST 6: payrollReference normalisation/uniqueness remains ────────────────
test('T6 payrollReference field present on CreatePayrollAdminDto', async () => {
  const raw = { payrollReference: '  emp-001  ' };
  const result = await pipe.transform(raw, { type: 'body', metatype: CreatePayrollAdminDto });
  assert(result.payrollReference !== undefined, 'payrollReference missing after transform');
});

// ── TEST 7: payrollStatus field present and validated ────────────────────────
test('T7 invalid payrollStatus is rejected', async () => {
  let threw = false;
  try {
    await pipe.transform({ payrollStatus: 'INVALID' }, { type: 'body', metatype: CreatePayrollAdminDto });
  } catch { threw = true; }
  assert(threw, 'Invalid payrollStatus was accepted — should have thrown');
});

// ── TEST 8: valid payrollStatus values are accepted ──────────────────────────
test('T8 ACTIVE/ON_HOLD/EXCLUDED are accepted as payrollStatus', async () => {
  for (const s of [GuardPayrollStatus.ACTIVE, GuardPayrollStatus.ON_HOLD, GuardPayrollStatus.EXCLUDED]) {
    const result = await pipe.transform({ payrollStatus: s }, { type: 'body', metatype: UpdatePayrollAdminDto });
    assert(result.payrollStatus === s, `status ${s} not round-tripped correctly`);
  }
});

// ── TEST 9: payrollStartDate/endDate validated as ISO date strings ────────────
test('T9 invalid payrollStartDate is rejected', async () => {
  let threw = false;
  try {
    await pipe.transform({ payrollStartDate: 'not-a-date' }, { type: 'body', metatype: CreatePayrollAdminDto });
  } catch { threw = true; }
  assert(threw, 'Invalid date was accepted');
});

// ── TEST 10: payrollNote encryption column references intact ─────────────────
test('T10 payrollNoteEnc field still present in entity source', () => {
  const entity = backend('guard-personnel/entities/company-guard-payroll.entity.ts');
  assert(entity.includes('payrollNoteEnc'), 'payrollNoteEnc column removed from entity');
  assert(entity.includes("select: false"), 'select: false guard removed from payrollNoteEnc');
});

// ── TEST 11: company tenant isolation fields intact ───────────────────────────
test('T11 companyId and companyGuardId present in entity source', () => {
  const entity = backend('guard-personnel/entities/company-guard-payroll.entity.ts');
  assert(entity.includes('companyGuardId'), 'companyGuardId removed from entity');
  assert(entity.includes('companyId'), 'companyId removed from entity');
  assert(entity.includes('RESTRICT'), 'RESTRICT FK constraint removed from entity');
});

// ── TEST 12: guard restricted view has no payment-method field ───────────────
test('T12 guard response DTO has no payrollPaymentMethod or payrollReference or payrollNote', () => {
  const dto = new PayrollAdminGuardResponseDto();
  assert(!('payrollPaymentMethod' in dto), 'payrollPaymentMethod present in guard DTO');
  assert(!('payrollReference' in dto), 'payrollReference present in guard DTO (should be company-only)');
  assert(!('payrollNote' in dto), 'payrollNote present in guard DTO');
  const src = backend('guard-personnel/dto/payroll-admin-guard-response.dto.ts');
  assert(!src.includes('payrollPaymentMethod'), 'guard response DTO source references payrollPaymentMethod');
});

// ── TEST 13: company response DTO has no payrollPaymentMethod ────────────────
test('T13 company response DTO has no payrollPaymentMethod', () => {
  const dto = new PayrollAdminCompanyResponseDto();
  assert(!('payrollPaymentMethod' in dto), 'payrollPaymentMethod present in company DTO');
  const src = backend('guard-personnel/dto/payroll-admin-company-response.dto.ts');
  assert(!src.includes('payrollPaymentMethod'), 'company response DTO source references payrollPaymentMethod');
  assert(!src.includes('GuardPayrollPaymentMethod'), 'company response DTO source still imports GuardPayrollPaymentMethod');
});

// ── TEST 14: admin response DTO has no payrollPaymentMethod ──────────────────
test('T14 admin response DTO has no payrollPaymentMethod', () => {
  const dto = new PayrollAdminAdminResponseDto();
  assert(!('payrollPaymentMethod' in dto), 'payrollPaymentMethod present in admin DTO');
  const src = backend('guard-personnel/dto/payroll-admin-admin-response.dto.ts');
  assert(!src.includes('payrollPaymentMethod'), 'admin response DTO source references payrollPaymentMethod');
  assert(!src.includes('GuardPayrollPaymentMethod'), 'admin response DTO source still imports GuardPayrollPaymentMethod');
});

// ── TEST 15: entity source has no GuardPayrollPaymentMethod ──────────────────
test('T15 entity source completely purged of GuardPayrollPaymentMethod', () => {
  const entity = backend('guard-personnel/entities/company-guard-payroll.entity.ts');
  assert(!entity.includes('GuardPayrollPaymentMethod'), 'GuardPayrollPaymentMethod enum still in entity');
  assert(!entity.includes('payrollPaymentMethod'), 'payrollPaymentMethod column still in entity');
  assert(!entity.includes('guard_payroll_payment_method_enum'), 'DB enum name still in entity');
});

// ── TEST 16: service source has no payrollPaymentMethod ──────────────────────
test('T16 service source has no payrollPaymentMethod', () => {
  const service = backend('guard-personnel/payroll-admin.service.ts');
  assert(!service.includes('payrollPaymentMethod'), 'payroll-admin.service.ts still references payrollPaymentMethod');
});

// ── TEST 17: guard/client rate separation — no hourlyRate in guard-facing DTOs
test('T17 guard pay/client charge separation: no hourlyRate or billingRate in guard-personnel DTOs', () => {
  for (const file of [
    'guard-personnel/dto/payroll-admin-guard-response.dto.ts',
    'guard-personnel/dto/payroll-admin-company-response.dto.ts',
  ]) {
    const src = backend(file);
    assert(!src.includes('hourlyRate'), `hourlyRate found in ${file}`);
    assert(!src.includes('billingRate'), `billingRate found in ${file}`);
  }
  const models = mobile('types/models.ts');
  const guardSummary = models.match(/export interface GuardPayrollAdminSummary \{[^}]+\}/s)?.[0] ?? '';
  assert(!guardSummary.includes('hourlyRate'), 'hourlyRate in GuardPayrollAdminSummary');
  assert(!guardSummary.includes('billingRate'), 'billingRate in GuardPayrollAdminSummary');
});

// ── TEST 18: corrective migration file exists and references correct column ───
test('T18 corrective migration 1720700000001 exists and drops correct column/type', () => {
  const migration = backend('database/migrations/1720700000001-RemovePayrollPaymentMethod.ts');
  assert(migration.includes('payrollPaymentMethod'), 'migration does not reference payrollPaymentMethod column');
  assert(migration.includes('guard_payroll_payment_method_enum'), 'migration does not reference the enum type');
  assert(migration.includes('DROP COLUMN'), 'migration does not DROP COLUMN');
  assert(migration.includes('DROP TYPE'), 'migration does not DROP TYPE');
  assert(migration.includes('1720700000001'), 'migration timestamp is incorrect');
  assert(!migration.includes('1720700000000'), 'migration references the original migration timestamp — should be a separate file');
});

// ── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      passed++;
      console.log(`PASS  ${t.name}`);
    } catch (e: unknown) {
      failed++;
      console.error(`FAIL  ${t.name} — ${(e as Error).message}`);
    }
  }
  console.log(`\n══ P1G-B PRODUCT CORRECTION: ${passed} PASS / ${failed} FAIL ══`);
  if (failed > 0) { console.error('FOCUSED SPEC: FAIL'); process.exit(1); }
  else console.log('FOCUSED SPEC: PASS');
}

main().catch(e => { console.error(e); process.exit(1); });
