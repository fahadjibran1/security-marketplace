/**
 * SEC-PUBLIC-04 compatibility: the global Guard response projection (src/common/privacy/guard-response-privacy.ts)
 * keeps everything a Guard needs from its own records and removes only other people's details and company money.
 * No database: each case projects entity instances shaped like the real responses (eager relations included).
 *
 *   GRP-SHIFT          shift times, site, instructions, geofence and own pay stay; owner, client, billing rate go
 *   GRP-TIMESHEET      hours, notes, payroll status and own pay (snapshot, payable amount, breakdown) stay;
 *                      client charge, revenue, cost, margin, invoice and payroll batch go
 *   GRP-INCIDENT       the Guard's own report (title, notes, severity, category, status, times) stays
 *   GRP-SAFETY-ALERT   welfare and emergency alerts keep type, priority, message and status
 *   GRP-NOTIFICATION   title, message, type, read state stay; the recipient is reduced to its id
 *   GRP-ATTACHMENT     file name, url, type and size stay; the uploader is reduced to its id
 *   GRP-PATROL-EVIDENCE  evidence ids, kind, status, capture time and coordinates stay
 *   GRP-JOB-APPLICATION  status and dates stay; the job keeps the Guard job fields only
 *   GRP-VALUES         dates, buffers, nulls and arrays pass unchanged; cycles terminate
 *   GRP-INTERCEPTOR    only Guard requests are projected
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { lastValueFrom, of } from 'rxjs';
import { GuardResponsePrivacyInterceptor, projectGuardResponse } from '../src/common/privacy/guard-response-privacy';
import { Company } from '../src/company/entities/company.entity';
import { User, UserRole } from '../src/user/entities/user.entity';
import { Client } from '../src/client/entities/client.entity';
import { Site } from '../src/site/entities/site.entity';
import { Job } from '../src/job/entities/job.entity';
import { GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { Timesheet } from '../src/timesheet/entities/timesheet.entity';
import { Incident } from '../src/incident/entities/incident.entity';
import { SafetyAlert } from '../src/safety-alert/entities/safety-alert.entity';
import { Notification } from '../src/notification/entities/notification.entity';
import { Attachment } from '../src/attachment/entities/attachment.entity';
import { PatrolEvidence } from '../src/patrol/entities/patrol-evidence.entity';
import { JobApplication } from '../src/job-application/entities/job-application.entity';

const make = <T extends object>(C: new () => T, fields: Record<string, unknown>): T => Object.assign(new C(), fields);
const P = (v: unknown) => JSON.parse(JSON.stringify(projectGuardResponse(v)));

const OWNER_EMAIL = 'owner.private@company-secret.test';
const CLIENT_EMAIL = 'contact.private@client-secret.test';

function world() {
  const owner = make(User, { id: 10, email: OWNER_EMAIL, role: UserRole.COMPANY_ADMIN, passwordHash: 'hash', phone: '07000000010' });
  const company = make(Company, { id: 1, name: 'Fictional Guarding Ltd', user: owner, companyNumber: '00000001', contactDetails: '020 0000 0001',
    address: '1 Company Street', verificationNote: 'internal note' });
  const client = make(Client, { id: 5, name: 'Fictional Client plc', contactName: 'Pat Private', contactEmail: CLIENT_EMAIL, contactPhone: '02000000005' });
  const site = make(Site, { id: 3, name: 'Riverside Depot', address: '2 River Road', contactDetails: 'Gatehouse 020 0000 0003', timezone: 'Europe/London',
    latitude: 51.5, longitude: -0.1, geofenceRadiusMeters: 150, requireGpsCheckIn: true, requireNfcCheckIn: false,
    specialInstructions: 'Lock gate B after 22:00', welfareCheckIntervalMinutes: 60, client, company });
  const guardUser = make(User, { id: 20, email: 'guard.self@guard.test', role: UserRole.GUARD, passwordHash: 'hash' });
  const guard = make(GuardProfile, { id: 7, fullName: 'Sam Guard', user: guardUser, phone: '07000000007', siaLicenseNumber: '1234567890123456' });
  const job = make(Job, { id: 4, title: 'Night cover', description: 'Static guarding', guardsRequired: 1, hourlyRate: 15.25, billingRate: 31.57,
    status: 'open', company, site });
  const shift = make(Shift, { id: 9, start: new Date('2026-12-01T20:00:00Z'), end: new Date('2026-12-02T06:00:00Z'), status: 'accepted',
    siteName: 'Riverside Depot', checkCallIntervalMinutes: 60, company, site, job, guard });
  return { owner, company, client, site, guardUser, guard, job, shift };
}

function assertNoSecrets(out: unknown, what: string) {
  const text = JSON.stringify(out);
  for (const s of [OWNER_EMAIL, CLIENT_EMAIL, 'Pat Private', '"passwordHash"', '"billingRate"', '"companyNumber"', '"verificationNote"', '"client"']) {
    assert.ok(!text.includes(s), `${what}: ${s} present`);
  }
}

const tests: Array<[string, () => void | Promise<void>]> = [
  ['GRP-SHIFT', () => {
    const { shift } = world();
    const out = P(shift);
    assertNoSecrets(out, 'shift');
    assert.equal(out.start, '2026-12-01T20:00:00.000Z');
    assert.equal(out.status, 'accepted');
    assert.equal(out.siteName, 'Riverside Depot');
    assert.equal(out.checkCallIntervalMinutes, 60);
    assert.deepEqual(out.company, { id: 1, name: 'Fictional Guarding Ltd' });
    assert.equal(out.site.specialInstructions, 'Lock gate B after 22:00');
    assert.equal(out.site.address, '2 River Road');
    assert.equal(out.site.contactDetails, 'Gatehouse 020 0000 0003', 'the site contact line a Guard on shift needs');
    assert.equal(out.site.geofenceRadiusMeters, 150);
    assert.equal(out.site.requireGpsCheckIn, true);
    assert.equal(out.site.timezone, 'Europe/London');
    assert.equal(out.job.hourlyRate, 15.25, 'own pay rate');
    assert.deepEqual(out.guard, { id: 7, fullName: 'Sam Guard' });
  }],
  ['GRP-TIMESHEET', () => {
    const { shift, guard, company } = world();
    const ts = make(Timesheet, { id: 11, shift, guard, company, approvalStatus: 'approved', hoursWorked: 8, approvedHours: 8, workedMinutes: 480,
      breakMinutes: 30, guardNote: 'Quiet night', companyNote: 'Thanks', payrollStatus: 'paid', payrollPaidAt: new Date('2026-12-10T00:00:00Z'),
      hourlyRateSnapshot: 15.25, payableHoursSnapshot: 8, payableAmountSnapshot: 122, payableHours: 8, payableAmount: 122,
      payBreakdown: { basePay: 122, premiums: [], billingRate: 31.57 },
      billingRateSnapshot: 31.57, clientBilledHoursSnapshot: 8, billingStatus: 'invoiced', invoiceIssuedAt: new Date(), billingRate: 31.57,
      effectiveBillingRate: 31.57, billableHours: 8, costAmount: 122, revenueAmount: 252.56, marginAmount: 130.56, marginPercent: 51.7,
      payrollBatch: { id: 2, reference: 'PB-2' }, invoiceBatch: { id: 3 } });
    const out = P(ts);
    assertNoSecrets(out, 'timesheet');
    for (const k of ['billingRateSnapshot', 'clientBilledHoursSnapshot', 'billingStatus', 'invoiceIssuedAt', 'effectiveBillingRate',
      'billableHours', 'costAmount', 'revenueAmount', 'marginAmount', 'marginPercent', 'payrollBatch', 'invoiceBatch']) {
      assert.ok(!(k in out), `${k} removed`);
    }
    assert.equal(out.hoursWorked, 8);
    assert.equal(out.approvedHours, 8);
    assert.equal(out.workedMinutes, 480);
    assert.equal(out.breakMinutes, 30);
    assert.equal(out.guardNote, 'Quiet night');
    assert.equal(out.companyNote, 'Thanks', 'the company\'s note to the Guard about the Guard\'s own timesheet');
    assert.equal(out.payrollStatus, 'paid');
    assert.equal(out.payrollPaidAt, '2026-12-10T00:00:00.000Z');
    assert.equal(out.hourlyRateSnapshot, 15.25);
    assert.equal(out.payableHoursSnapshot, 8);
    assert.equal(out.payableAmountSnapshot, 122);
    assert.equal(out.payableAmount, 122);
    assert.deepEqual(out.payBreakdown, { basePay: 122, premiums: [] });
    assert.equal(out.shift.id, 9);
  }],
  ['GRP-INCIDENT', () => {
    const { shift, guard, company, site } = world();
    const out = P(make(Incident, { id: 12, company, guard, shift, site, title: 'Broken fence', notes: 'North side', severity: 'high',
      category: 'property', locationText: 'Gate B', status: 'open', reportedAt: new Date('2026-12-01T23:00:00Z'), resolutionNote: null }));
    assertNoSecrets(out, 'incident');
    assert.equal(out.title, 'Broken fence');
    assert.equal(out.notes, 'North side');
    assert.equal(out.severity, 'high');
    assert.equal(out.category, 'property');
    assert.equal(out.locationText, 'Gate B');
    assert.equal(out.status, 'open');
    assert.equal(out.reportedAt, '2026-12-01T23:00:00.000Z');
    assert.equal(out.resolutionNote, null);
    assert.equal(out.site.name, 'Riverside Depot');
  }],
  ['GRP-SAFETY-ALERT', () => {
    const { shift, guard, company } = world();
    for (const type of ['panic', 'welfare_missed', 'other']) {
      const out = P(make(SafetyAlert, { id: 13, company, guard, shift, type, priority: 'critical', message: 'Help needed at gate B',
        status: 'open', createdAt: new Date('2026-12-01T23:30:00Z') }));
      assertNoSecrets(out, `alert ${type}`);
      assert.equal(out.type, type);
      assert.equal(out.priority, 'critical');
      assert.equal(out.message, 'Help needed at gate B');
      assert.equal(out.status, 'open');
      assert.equal(out.shift.id, 9);
    }
  }],
  ['GRP-NOTIFICATION', () => {
    const { guardUser, company } = world();
    const out = P([make(Notification, { id: 14, user: guardUser, company, type: 'shift_offered', title: 'New shift', message: 'Open S4',
      status: 'unread', readAt: null, createdAt: new Date('2026-12-01T10:00:00Z') })]);
    assertNoSecrets(out, 'notification');
    assert.equal(out[0].title, 'New shift');
    assert.equal(out[0].message, 'Open S4');
    assert.equal(out[0].type, 'shift_offered');
    assert.equal(out[0].status, 'unread');
    assert.deepEqual(out[0].user, { id: 20 });
  }],
  ['GRP-ATTACHMENT', () => {
    const { guardUser, company } = world();
    const out = P(make(Attachment, { id: 15, company, uploadedBy: guardUser, entityType: 'incident', entityId: 12, fileName: 'fence.jpg',
      fileUrl: '/attachments/15/file', mimeType: 'image/jpeg', sizeBytes: 2048, createdAt: new Date('2026-12-01T23:05:00Z') }));
    assertNoSecrets(out, 'attachment');
    assert.equal(out.fileName, 'fence.jpg');
    assert.equal(out.fileUrl, '/attachments/15/file');
    assert.equal(out.mimeType, 'image/jpeg');
    assert.equal(out.sizeBytes, 2048);
    assert.equal(out.entityType, 'incident');
    assert.equal(out.entityId, 12);
    assert.deepEqual(out.uploadedBy, { id: 20 });
  }],
  ['GRP-PATROL-EVIDENCE', () => {
    const out = P(make(PatrolEvidence, { id: 16, companyId: 1, siteId: 3, runId: 4, visitId: 5, guardId: 7, shiftId: 9, source: 'camera',
      kind: 'photo', mimeType: 'image/jpeg', capturedAtDevice: new Date('2026-12-01T22:00:00Z'), uploadStatus: 'verified',
      latitude: 51.5, longitude: -0.1, accuracyMeters: 8 }));
    assert.equal(out.kind, 'photo');
    assert.equal(out.uploadStatus, 'verified');
    assert.equal(out.runId, 4);
    assert.equal(out.visitId, 5);
    assert.equal(out.capturedAtDevice, '2026-12-01T22:00:00.000Z');
    assert.equal(out.latitude, 51.5);
    assert.equal(out.accuracyMeters, 8);
  }],
  ['GRP-JOB-APPLICATION', () => {
    const { job, guard } = world();
    const out = P(make(JobApplication, { id: 17, job, guard, status: 'hired', appliedAt: new Date('2026-11-30T09:00:00Z'),
      hiredAt: new Date('2026-11-30T12:00:00Z') }));
    assertNoSecrets(out, 'application');
    assert.equal(out.status, 'hired');
    assert.equal(out.appliedAt, '2026-11-30T09:00:00.000Z');
    assert.equal(out.hiredAt, '2026-11-30T12:00:00.000Z');
    assert.deepEqual(Object.keys(out.job).sort(),
      ['company', 'description', 'guardsRequired', 'hourlyRate', 'id', 'site', 'startAt', 'endAt', 'status', 'title']
        .filter((k) => k in job).sort());
    assert.equal(out.job.hourlyRate, 15.25);
  }],
  ['GRP-VALUES', () => {
    const d = new Date('2026-12-01T00:00:00Z');
    const buf = Buffer.from('evidence');
    const out = projectGuardResponse({ d, buf, n: null, u: undefined, list: [1, 'a', null], nested: { deep: { ok: true } } }) as any;
    assert.equal(out.d, d, 'a Date passes unchanged');
    assert.equal(out.buf, buf, 'a Buffer passes unchanged');
    assert.equal(out.n, null);
    assert.deepEqual(out.list, [1, 'a', null]);
    assert.equal(out.nested.deep.ok, true);
    const { shift, company } = world();
    (company as any).shifts = [shift];
    const cyclic = projectGuardResponse(shift) as any;
    assert.deepEqual(cyclic.company, { id: 1, name: 'Fictional Guarding Ltd' });
    assert.equal(projectGuardResponse(null), null);
    assert.equal(projectGuardResponse('text'), 'text');
  }],
  ['GRP-INTERCEPTOR', async () => {
    const interceptor = new GuardResponsePrivacyInterceptor();
    const ctx = (role: string) => ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }) }) as any;
    const { shift } = world();
    const asGuard: any = await lastValueFrom(interceptor.intercept(ctx(UserRole.GUARD), { handle: () => of(shift) }));
    assert.deepEqual(asGuard.company, { id: 1, name: 'Fictional Guarding Ltd' });
    for (const role of [UserRole.COMPANY_ADMIN, UserRole.ADMIN]) {
      const raw: any = await lastValueFrom(interceptor.intercept(ctx(role), { handle: () => of(shift) }));
      assert.equal(raw, shift, `${role} responses are untouched`);
    }
  }],
];

async function main() {
  const failures: string[] = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (e) {
      failures.push(name);
      console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
    }
  }
  console.log(JSON.stringify({ event: failures.length ? 'guard_response_privacy_failed' : 'guard_response_privacy_passed', tests: tests.length, failures }));
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
