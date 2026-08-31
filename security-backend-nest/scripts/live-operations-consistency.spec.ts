import 'reflect-metadata';

import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  CoverageService,
  coverageCalendarBoundary,
  isUncoveredOperationalShift,
} from '../src/coverage/coverage.service';

type Test = { name: string; run: () => void | Promise<void> };
const tests: Test[] = [];
const test = (name: string, run: Test['run']) => tests.push({ name, run });
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

const site = { id: 10, name: 'Current Site', client: { id: 20, name: 'Current Client' }, requiredGuardCount: 1 };
const makeShift = (id: number, start: Date, status = 'unfilled', guard: any = null, companyId = 1) => ({
  id, start, end: new Date(start.getTime() + 15 * 60 * 60 * 1000), status, guard,
  company: { id: companyId }, site, siteName: site.name, job: null,
});

function serviceFor(rows: any[], companyId = 1) {
  let repositoryCompanyId: number | undefined;
  const service = new CoverageService({
    find: async (options: any) => {
      repositoryCompanyId = options.where.company.id;
      const [from, to] = options.where.start.value as Date[];
      return rows.filter((row) => row.company.id === repositoryCompanyId && row.start >= from && row.start <= to);
    },
    findOne: async () => null,
  } as any, { findByUserId: async () => ({ id: companyId }) } as any, {} as any);
  return { service, repositoryCompanyId: () => repositoryCompanyId };
}

test('UK summer calendar boundary starts at London midnight', () => {
  assert(coverageCalendarBoundary('2026-08-23', false).toISOString() === '2026-08-22T23:00:00.000Z', 'summer boundary incorrect');
});
test('UK winter calendar boundary starts at London midnight', () => {
  assert(coverageCalendarBoundary('2026-12-23', false).toISOString() === '2026-12-23T00:00:00.000Z', 'winter boundary incorrect');
});
test('shift that started earlier today remains in default coverage', async () => {
  const today = coverageCalendarBoundary(undefined, false);
  const current = makeShift(1, new Date(today.getTime() + 5 * 60 * 60 * 1000));
  const { service } = serviceFor([current]);
  assert((await service.listShiftCoverage(7, { uncoveredOnly: 'true' })).some((row) => row.shiftId === 1), 'current shift excluded');
});
test('current unfilled shift is uncovered', () => {
  assert(isUncoveredOperationalShift(makeShift(1, new Date()) as any), 'unfilled shift not uncovered');
});
test('current ready and in-progress shifts with confirmed guards are covered', () => {
  assert(!isUncoveredOperationalShift(makeShift(1, new Date(), 'ready', { id: 1 }) as any), 'ready shift uncovered');
  assert(!isUncoveredOperationalShift(makeShift(2, new Date(), 'in_progress', { id: 1 }) as any), 'live shift uncovered');
});
test('current offered shift remains uncovered until acceptance', () => {
  assert(isUncoveredOperationalShift(makeShift(1, new Date(), 'offered', { id: 1 }) as any), 'pending offer treated as cover');
});
test('completed and cancelled historical/current shifts are excluded', async () => {
  const today = coverageCalendarBoundary(undefined, false);
  const rows = [makeShift(1, new Date(today.getTime() + 1000), 'completed'), makeShift(2, new Date(today.getTime() + 2000), 'cancelled')];
  const { service } = serviceFor(rows);
  assert((await service.listShiftCoverage(7, {})).length === 0, 'non-operational shift leaked');
});
test('future unfilled and tomorrow shifts remain in upcoming window', async () => {
  const today = coverageCalendarBoundary(undefined, false);
  const rows = [makeShift(1, new Date(today.getTime() + 60 * 60 * 1000)), makeShift(2, new Date(today.getTime() + 25 * 60 * 60 * 1000))];
  const { service } = serviceFor(rows);
  assert((await service.listShiftCoverage(7, { uncoveredOnly: 'true' })).length === 2, 'upcoming coverage window regressed');
});
test('explicit from and to retain UK calendar-day bounds', () => {
  assert(coverageCalendarBoundary('2026-08-23', false).toISOString() === '2026-08-22T23:00:00.000Z', 'explicit from incorrect');
  assert(coverageCalendarBoundary('2026-08-23', true).toISOString() === '2026-08-23T22:59:59.999Z', 'explicit to incorrect');
});
test('tenant isolation remains repository-enforced', async () => {
  const today = coverageCalendarBoundary(undefined, false);
  const { service, repositoryCompanyId } = serviceFor([makeShift(1, today, 'unfilled', null, 1), makeShift(2, today, 'unfilled', null, 2)]);
  const rows = await service.listShiftCoverage(7, { uncoveredOnly: 'true' });
  assert(repositoryCompanyId() === 1 && rows.length === 1 && rows[0].shiftId === 1, 'tenant scope failed');
});
test('Dashboard and Live Operations still consume authoritative Coverage rows', () => {
  const source = readFileSync(resolve(__dirname, '../../security-mobile-app/src/screens/CompanyDashboardScreen.tsx'), 'utf8');
  assert(source.includes("listCoverageShifts({ uncoveredOnly: true })"), 'authoritative API not consumed');
  assert(source.includes("category: 'uncovered_shift'") && source.includes("label: 'Uncovered Shifts'"), 'surfaces not wired');
});
test('Review Shift selects, highlights and focuses the detail panel', () => {
  const source = readFileSync(resolve(__dirname, '../../security-mobile-app/src/screens/CompanyDashboardScreen.tsx'), 'utf8');
  assert(source.includes('focusShiftDetail(shift.id)'), 'Review Shift does not focus detail');
  assert(source.includes('setPendingShiftDetailFocusId(shiftId)') && source.includes('contentScrollRef.current?.scrollTo'), 'detail scrolling missing');
  assert(source.includes('selectedShiftId === shift.id && styles.liveBoardTableRowSelected'), 'selection is not persistent');
});
test('unfilled detail exposes safe Coverage route and operational context', () => {
  const source = readFileSync(resolve(__dirname, '../../security-mobile-app/src/screens/CompanyDashboardScreen.tsx'), 'utf8');
  assert(source.includes('Manage Coverage') && source.includes('openCoverage({ uncoveredOnly: true, shiftId: selectedShift.id })'), 'coverage action missing');
  ['Shift #{selectedShift.id} Operations', "selectedShift.site?.name", 'formatDateLabel(selectedShift.start)', "selectedShift.guard?.fullName || 'No guard assigned'", 'ShiftStatusBadge'].forEach((value) => assert(source.includes(value), `missing detail: ${value}`));
});

async function main() {
  let passed = 0;
  for (const entry of tests) { await entry.run(); console.log(`PASS ${++passed}/${tests.length} ${entry.name}`); }
  console.log(`SEC-018D live operations consistency: ${passed}/${tests.length} PASS`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
