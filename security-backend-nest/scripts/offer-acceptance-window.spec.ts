/**
 * The expired-offer rule (owner decision, 21 Oct 2026), executed without a database.
 *
 *   OAW-01  boundaries: before start, exactly at start, 1 ms before end, exactly at end, after end
 *   OAW-02  overnight shifts are judged by instants, not by calendar day
 *   OAW-03  clock changes: a shift spanning BST→GMT and GMT→BST is open for exactly its true length
 *   OAW-04  the refusal is a 409 with a machine-readable code and plain wording, never a 500
 *   OAW-05  the service enforces it twice: on the server clock before any work, and in the atomic UPDATE by the
 *           database clock; declining is never blocked
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ConflictException } from '@nestjs/common';
import {
  offerAcceptanceWindow, SHIFT_OFFER_EXPIRED_CODE, shiftOfferExpiredException,
} from '../src/shift/offer-acceptance-window';

let passed = 0;
const test = (id: string, fn: () => void) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const at = (iso: string) => new Date(iso);

test('OAW-01-BOUNDARIES', () => {
  const start = at('2026-10-22T08:00:00Z'), end = at('2026-10-22T16:00:00Z');
  assert.equal(offerAcceptanceWindow(start, end, at('2026-10-22T07:59:59.999Z')), 'before_start');
  assert.equal(offerAcceptanceWindow(start, end, start), 'started', 'exactly at the start: started, still acceptable');
  assert.equal(offerAcceptanceWindow(start, end, at('2026-10-22T15:59:59.999Z')), 'started', '1 ms before the end: acceptable');
  assert.equal(offerAcceptanceWindow(start, end, end), 'ended', 'exactly at the end: expired');
  assert.equal(offerAcceptanceWindow(start, end, at('2026-10-23T04:00:00Z')), 'ended');
});

test('OAW-02-OVERNIGHT', () => {
  // Production shift 42: 18:00 → 06:00 next day.
  const start = at('2026-10-20T18:00:00Z'), end = at('2026-10-21T06:00:00Z');
  assert.equal(offerAcceptanceWindow(start, end, at('2026-10-20T23:59:59Z')), 'started', 'before midnight: running');
  assert.equal(offerAcceptanceWindow(start, end, at('2026-10-21T00:00:01Z')), 'started', 'after midnight, same shift: running');
  assert.equal(offerAcceptanceWindow(start, end, at('2026-10-21T18:10:52Z')), 'ended', 'the 21 Oct acceptance would now be refused');
});

test('OAW-03-CLOCK-CHANGES', () => {
  // Autumn: 22:00 BST Sat 24 Oct 2026 (21:00Z) → 06:00 GMT Sun 25 Oct 2026 (06:00Z) = 9 hours.
  const aStart = at('2026-10-24T21:00:00Z'), aEnd = at('2026-10-25T06:00:00Z');
  assert.equal((aEnd.getTime() - aStart.getTime()) / 3_600_000, 9);
  // 01:30 local happens twice that night (00:30Z BST, then 01:30Z GMT): both are inside the shift.
  assert.equal(offerAcceptanceWindow(aStart, aEnd, at('2026-10-25T00:30:00Z')), 'started');
  assert.equal(offerAcceptanceWindow(aStart, aEnd, at('2026-10-25T01:30:00Z')), 'started');
  assert.equal(offerAcceptanceWindow(aStart, aEnd, at('2026-10-25T05:59:59Z')), 'started', 'not closed an hour early by the repeated hour');
  assert.equal(offerAcceptanceWindow(aStart, aEnd, aEnd), 'ended');
  // Spring: 22:00 GMT Sat 27 Mar 2027 (22:00Z) → 06:00 BST Sun 28 Mar 2027 (05:00Z) = 7 hours.
  const sStart = at('2027-03-27T22:00:00Z'), sEnd = at('2027-03-28T05:00:00Z');
  assert.equal((sEnd.getTime() - sStart.getTime()) / 3_600_000, 7);
  assert.equal(offerAcceptanceWindow(sStart, sEnd, at('2027-03-28T04:59:59Z')), 'started', 'not held open an extra hour');
  assert.equal(offerAcceptanceWindow(sStart, sEnd, at('2027-03-28T05:00:00Z')), 'ended');
});

test('OAW-04-A-CLEAR-409', () => {
  const e = shiftOfferExpiredException();
  assert.ok(e instanceof ConflictException);
  assert.equal(e.getStatus(), 409);
  const body = e.getResponse() as any;
  assert.equal(body.code, SHIFT_OFFER_EXPIRED_CODE);
  assert.equal(body.code, 'SHIFT_OFFER_EXPIRED');
  assert.match(body.message, /already ended/);
  assert.match(body.message, /control room/);
});

test('OAW-05-ENFORCED-ON-SERVER-AND-DATABASE-CLOCKS-ACCEPT-ONLY', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shift', 'shift.service.ts'), 'utf8');
  const respond = src.split('async respondForGuard(')[1].split('assertGuardCanOperateShift(')[0];
  const preCheck = respond.indexOf("offerAcceptanceWindow(new Date(preCheck.start), new Date(preCheck.end), new Date()) === 'ended'");
  assert.ok(preCheck > 0, 'server-clock check present');
  assert.ok(preCheck < respond.indexOf('assertGuardCanTakeShift'), 'checked before the eligibility work');
  assert.match(respond, /if \(dto\.response === 'accepted' && offerAcceptanceWindow/, 'acceptance only: declining is never blocked');
  assert.match(respond, /AND \(\$1 <> 'ready' OR "end" > \(statement_timestamp\(\) AT TIME ZONE 'UTC'\)\)/, 'the atomic UPDATE re-checks by the database clock');
  // The UPDATE runs inside a transaction that begins before the eligibility checks, where now() would be that
  // earlier moment; only the statement clock is the database time of the write itself.
  assert.ok(!/"end" > \(now\(\)/.test(respond), 'the expiry re-check does not use the transaction-start clock');
  assert.match(respond, /if \(dto\.response === 'accepted' && current\.status === 'offered'\) \{\s*throw shiftOfferExpiredException\(\);/, 'an in-flight expiry is reported as expired');
  // Nothing deletes or re-statuses an expired offer.
  assert.ok(!/DELETE FROM "shifts"|status: 'missed'|'expired'/.test(respond), 'no deletion or status change for expired offers');
});

console.log(`\n${passed} offer acceptance window checks passed`);
