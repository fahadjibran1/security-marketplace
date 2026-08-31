import 'reflect-metadata';

import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  CoverageService,
  hasConfirmedShiftCover,
  isOperationalCoverageShift,
  isUncoveredOperationalShift,
} from '../src/coverage/coverage.service';

type Test = { name: string; run: () => void | Promise<void> };
const tests: Test[] = [];
const test = (name: string, run: Test['run']) => tests.push({ name, run });
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const future = (days: number) => new Date(Date.now() + days * 86_400_000);
const shift = (id: number, status = 'unfilled', siteId = 10, guard: any = null, companyId = 1) => ({
  id,
  status,
  guard,
  company: { id: companyId },
  site: { id: siteId, name: `Site ${siteId}`, client: { id: siteId, name: `Client ${siteId}` }, requiredGuardCount: 1 },
  siteName: `Site ${siteId}`,
  start: future(1),
  end: future(1.25),
  job: null,
});

function serviceFor(rows: any[], companyId = 1) {
  let receivedWhere: any;
  const service = new CoverageService(
    {
      find: async (options: any) => {
        receivedWhere = options.where;
        return rows.filter((row) => row.company.id === options.where.company.id);
      },
      findOne: async () => null,
    } as any,
    { findByUserId: async () => ({ id: companyId }) } as any,
    {} as any,
  );
  return { service, receivedWhere: () => receivedWhere };
}

test('zero uncovered shifts', async () => {
  const { service } = serviceFor([shift(1, 'ready', 10, { id: 5 })]);
  assert((await service.listShiftCoverage(7, { uncoveredOnly: 'true' })).length === 0, 'expected zero');
});
test('one uncovered shift', async () => {
  const { service } = serviceFor([shift(1)]);
  assert((await service.listShiftCoverage(7, { uncoveredOnly: 'true' })).length === 1, 'expected one');
});
test('multiple uncovered shifts', async () => {
  const { service } = serviceFor([shift(1), shift(2)]);
  assert((await service.listShiftCoverage(7, { uncoveredOnly: 'true' })).length === 2, 'expected two');
});
test('same-site gaps aggregate to one site', async () => {
  const { service } = serviceFor([shift(1), shift(2)]);
  assert((await service.listSiteCoverage(7, { uncoveredOnly: 'true' })).length === 1, 'expected one site');
});
test('distinct-site gaps aggregate separately', async () => {
  const { service } = serviceFor([shift(1, 'unfilled', 10), shift(2, 'unfilled', 20)]);
  assert((await service.listSiteCoverage(7, { uncoveredOnly: 'true' })).length === 2, 'expected two sites');
});
test('confirmed assigned shift is covered', () => assert(hasConfirmedShiftCover(shift(1, 'ready', 10, { id: 5 }) as any), 'expected cover'));
test('cancelled shift is non-operational', () => assert(!isOperationalCoverageShift(shift(1, 'cancelled') as any), 'cancelled leaked'));
test('completed and missed shifts are non-operational', () => {
  assert(!isOperationalCoverageShift(shift(1, 'completed') as any), 'completed leaked');
  assert(!isOperationalCoverageShift(shift(2, 'missed') as any), 'missed leaked');
});
test('company isolation is applied in repository query', async () => {
  const { service, receivedWhere } = serviceFor([shift(1, 'unfilled', 10, null, 1), shift(2, 'unfilled', 20, null, 2)]);
  const rows = await service.listShiftCoverage(7, { uncoveredOnly: 'true' });
  assert(rows.length === 1 && receivedWhere().company.id === 1, 'tenant scope missing');
});
test('dashboard consumes authoritative uncovered API count', () => {
  const source = readFileSync(resolve(__dirname, '../../security-mobile-app/src/screens/CompanyDashboardScreen.tsx'), 'utf8');
  assert(source.includes("listCoverageShifts({ uncoveredOnly: true })") && source.includes("label: 'Uncovered Shifts'"), 'dashboard wiring missing');
});
test('Live Operations adds uncovered rows to urgent queue', () => {
  const source = readFileSync(resolve(__dirname, '../../security-mobile-app/src/screens/CompanyDashboardScreen.tsx'), 'utf8');
  assert(source.includes("category: 'uncovered_shift'") && source.includes('Manage coverage'), 'urgent queue wiring missing');
});
test('dashboard deep link opens uncovered Coverage', () => {
  const source = readFileSync(resolve(__dirname, '../../security-mobile-app/src/screens/CompanyDashboardScreen.tsx'), 'utf8');
  assert(source.includes("coverageContext: { uncoveredOnly: true }"), 'dashboard context missing');
});
test('Live Operations deep link carries specific shift', () => {
  const source = readFileSync(resolve(__dirname, '../../security-mobile-app/src/screens/CompanyDashboardScreen.tsx'), 'utf8');
  assert(source.includes("openCoverage({ uncoveredOnly: true, shiftId: item.shiftId })"), 'shift context missing');
});
test('direct Coverage navigation clears deep-link filters', () => {
  const source = readFileSync(resolve(__dirname, '../../security-mobile-app/src/screens/CompanyDashboardScreen.tsx'), 'utf8');
  assert(source.includes("if (section === 'coverage') setCoverageNavigationContext(undefined)"), 'direct navigation not reset');
});
test('accepting and invalidating cover update authoritative state', () => {
  assert(!isUncoveredOperationalShift(shift(1, 'ready', 10, { id: 5 }) as any), 'accepted shift remained uncovered');
  assert(isUncoveredOperationalShift(shift(1, 'rejected', 10, { id: 5 }) as any), 'rejected cover did not return');
});

async function main() {
  let passed = 0;
  for (const entry of tests) {
    await entry.run();
    passed += 1;
    console.log(`PASS ${passed}/${tests.length} ${entry.name}`);
  }
  console.log(`SEC-018B operational coverage: ${passed}/${tests.length} PASS`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
