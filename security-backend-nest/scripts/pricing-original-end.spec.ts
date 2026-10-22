/**
 * PROPOSAL (not approved for release): contract pricing keeps the ORIGINAL overnight classification when a Live Shift
 * Amendment extends a shift (owner decision, 22 Oct 2026). Pure — no database, no network.
 *
 *   PO-01  an unextended day shift prices on the day rule (unchanged behaviour)
 *   PO-02  an unextended overnight shift prices on the overnight rule (unchanged behaviour)
 *   PO-03  a day shift extended past midnight (draft timesheet synced to the new end) still prices on the day rule
 *   PO-04  the same when the timesheet has no scheduled end and the shift's (extended) end is the fallback
 *   PO-05  an overnight shift extended further stays overnight
 *   PO-06  a locked (approved, frozen-snapshot) timesheet: revenue is identical before and after its shift is extended
 *   PO-07  the extended hours are still billed: billable hours follow approved (attendance-verified) hours, not the schedule
 *   PO-08  PRC-001 is untouched by this change: classification still uses the process (UTC) calendar date
 *   PO-09  every extension is flagged for billing review (Migration 64 default) — the review, not silent re-pricing
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContractPricingService } from '../src/contract-pricing/contract-pricing.service';

let passed = 0;
const test = (id: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS  ${id}`);
};

const service = new ContractPricingService({} as never, {} as never, {} as never, {} as never, {} as never);
const client = { id: 1 };
const site = { id: 7, client };
const rule = (id: number, name: string, overnight: boolean, rate: number) =>
  ({ id, name, client, site: null, status: 'active', priority: 100, billingRate: rate, appliesOnOvernightShift: overnight,
    effectiveFrom: null, effectiveTo: null, startTime: null, endTime: null, appliesOnWeekendOnly: false,
    appliesOnSunday: true, appliesOnMonday: true, appliesOnTuesday: true, appliesOnWednesday: true, appliesOnThursday: true,
    appliesOnFriday: true, appliesOnSaturday: true,
    deductionHoursBeforeBilling: null, roundUpToMinutes: null, minimumBillableHours: null, flatCallOutFee: null }) as any;
const DAY = rule(1, 'Day rate', false, 20);
const NIGHT = rule(2, 'Overnight rate', true, 30);
const RULES = [DAY, NIGHT];

const at = (iso: string) => new Date(iso);
/** An approved timesheet on a shift. `originalEnd` set = the shift was extended (Migration 64 column). */
const sheet = (o: { start: string; end: string; originalEnd?: string; scheduledEnd?: string | null; hours: number; snapshot?: number }) => ({
  approvalStatus: 'approved',
  scheduledStartAt: at(o.start),
  scheduledEndAt: o.scheduledEnd === null ? null : at(o.scheduledEnd ?? o.end),
  approvedMinutes: o.hours * 60,
  approvedHoursSnapshot: o.snapshot ?? null,
  createdAt: at(o.start),
  shift: { start: at(o.start), end: at(o.end), originalEnd: o.originalEnd ? at(o.originalEnd) : null, site },
}) as any;
const price = (t: any) => service.deriveTimesheetFinancials(t, RULES);

test('PO-01-UNEXTENDED-DAY-SHIFT-IS-UNCHANGED', () => {
  const r = price(sheet({ start: '2026-11-10T08:00:00Z', end: '2026-11-10T16:00:00Z', hours: 8 }));
  assert.equal(r.matchedContractRuleId, DAY.id);
  assert.equal(r.revenueAmount, 160);
});

test('PO-02-UNEXTENDED-OVERNIGHT-SHIFT-IS-UNCHANGED', () => {
  const r = price(sheet({ start: '2026-11-10T22:00:00Z', end: '2026-11-11T06:00:00Z', hours: 8 }));
  assert.equal(r.matchedContractRuleId, NIGHT.id);
  assert.equal(r.revenueAmount, 240);
});

test('PO-03-DAY-SHIFT-EXTENDED-PAST-MIDNIGHT-KEEPS-THE-DAY-RULE', () => {
  // 14:00–22:00, extended to 01:00; the draft timesheet's scheduled end was synced to 01:00 (owner rule D2).
  const r = price(sheet({ start: '2026-11-10T14:00:00Z', end: '2026-11-11T01:00:00Z', originalEnd: '2026-11-10T22:00:00Z', hours: 11 }));
  assert.equal(r.matchedContractRuleId, DAY.id, 'the original (day) classification is kept — the whole shift is not re-priced as overnight');
  assert.equal(r.revenueAmount, 220, 'all 11 attendance-verified hours at the day rate');
});

test('PO-04-THE-SAME-WHEN-THE-SHIFT-END-IS-THE-FALLBACK', () => {
  const r = price(sheet({ start: '2026-11-10T14:00:00Z', end: '2026-11-11T01:00:00Z', originalEnd: '2026-11-10T22:00:00Z', scheduledEnd: null, hours: 11 }));
  assert.equal(r.matchedContractRuleId, DAY.id);
});

test('PO-05-AN-OVERNIGHT-SHIFT-EXTENDED-FURTHER-STAYS-OVERNIGHT', () => {
  const r = price(sheet({ start: '2026-11-10T22:00:00Z', end: '2026-11-11T08:00:00Z', originalEnd: '2026-11-11T06:00:00Z', hours: 10 }));
  assert.equal(r.matchedContractRuleId, NIGHT.id);
  assert.equal(r.revenueAmount, 300);
});

test('PO-06-A-LOCKED-TIMESHEET-PRICES-IDENTICALLY-BEFORE-AND-AFTER-ITS-SHIFT-IS-EXTENDED', () => {
  // An approved timesheet keeps its original scheduled end (never synced) and a frozen approved-hours snapshot. Its
  // shift is then extended past midnight (shift.end and originalEnd change on the SHIFT only).
  const before = price(sheet({ start: '2026-11-10T14:00:00Z', end: '2026-11-10T22:00:00Z', hours: 8, snapshot: 8 }));
  const after = price(sheet({ start: '2026-11-10T14:00:00Z', end: '2026-11-11T01:00:00Z', originalEnd: '2026-11-10T22:00:00Z',
    scheduledEnd: '2026-11-10T22:00:00Z', hours: 11, snapshot: 8 }));
  assert.deepEqual(after, before, 'the frozen basis is untouched (PRC-002 recompute-on-read cannot drift either)');
});

test('PO-07-EXTENDED-HOURS-ARE-STILL-BILLED-FROM-APPROVED-HOURS', () => {
  const r = price(sheet({ start: '2026-11-10T14:00:00Z', end: '2026-11-11T01:00:00Z', originalEnd: '2026-11-10T22:00:00Z', hours: 11 }));
  assert.equal(r.billableHours, 11, 'billable hours are the approved, attendance-verified hours — the rule decides the rate only');
});

test('PO-08-PRC-001-IS-UNCHANGED-BY-THIS-PROPOSAL', () => {
  // 23:30–00:30 BST = 22:30–23:30 UTC: still "not overnight" by the UTC calendar date. PRC-001 (site time zone) is a
  // separate correction; this proposal does not change how dates are read, only WHICH end is classified.
  const r = price(sheet({ start: '2026-10-20T22:30:00Z', end: '2026-10-20T23:30:00Z', hours: 1 }));
  assert.equal(r.matchedContractRuleId, DAY.id, 'known PRC-001 behaviour, deliberately unchanged here');
});

test('PO-09-EVERY-EXTENSION-IS-FLAGGED-FOR-BILLING-REVIEW', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'src', 'database', 'migrations', '1720900000010-AddShiftAmendments.ts'), 'utf8');
  assert.match(migration, /"billingReviewRequired"\s+boolean NOT NULL DEFAULT true/);
});

console.log(`\n${passed} pricing original-end checks passed`);
