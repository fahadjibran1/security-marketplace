import { strict as assert } from 'assert';
import { Queryable, runPreflight } from './release-data-preflight';

type Fixture = Partial<Record<string, Record<string, unknown>[]>>;

function fixtureDb(fixture: Fixture): Queryable {
  return {
    async query(sql: string) {
      const match = Object.keys(fixture).find((token) => sql.includes(token));
      return { rows: match ? fixture[match]! : [] };
    },
  };
}

async function main() {
  const clean = await runPreflight(fixtureDb({}));
  assert.equal(clean.status, 'PASS', 'clean database must pass');

  const orphanClient = await runPreflight(fixtureDb({ 'FROM "clients" c LEFT JOIN': [{ id: 1, companyId: null }] }));
  assert.equal(orphanClient.status, 'BLOCKED', 'orphan client must block');

  const orphanPayroll = await runPreflight(fixtureDb({ 'FROM "payroll_batches" pb LEFT JOIN': [{ id: 2, companyId: 999 }] }));
  assert.equal(orphanPayroll.status, 'BLOCKED', 'orphan payroll batch must block');

  const invalidTimesheet = await runPreflight(fixtureDb({ 'FROM "timesheets" t\n      LEFT JOIN "shifts"': [{ id: 3, shiftId: null }] }));
  assert.equal(invalidTimesheet.status, 'BLOCKED', 'invalid timesheet ownership must block');

  const invalidInvoice = await runPreflight(fixtureDb({ 'LEFT JOIN "invoice_batches" ib': [{ id: 4, invoiceBatchId: 44 }] }));
  assert.equal(invalidInvoice.status, 'BLOCKED', 'invalid invoice membership must block');

  const legacy = await runPreflight(fixtureDb({ "to_jsonb(t)->>'verifiedMinutes'": [{ id: 5, companyId: 1, guardId: 2, shiftId: 3, hoursWorked: '8.00', approvedHours: '8.00', approvalStatus: 'approved' }] }));
  assert.equal(legacy.status, 'PASS', 'legacy financial review alone must not block');
  assert.equal(legacy.reviewRequired.legacyApprovedTimesheetsWithoutVerifiedAttendance, 1);

  const ambiguousDocument = await runPreflight(fixtureDb({ 'FROM "guard_documents" gd': [{ id: 6, guardId: 2, companyId: null, uploadedByUserId: null }] }));
  assert.equal(ambiguousDocument.status, 'BLOCKED', 'legacy guard documents without reliable provenance must block');
  assert.equal(ambiguousDocument.blockers.guardDocumentsWithoutProvenance, 1);

  const legacyUrl = await runPreflight(fixtureDb({ "to_jsonb(gd)->>'fileUrl'": [{ id: 7, guardId: 2, companyId: 1 }] }));
  assert.equal(legacyUrl.status, 'BLOCKED', 'legacy external compliance URLs must block production release');
  assert.equal(legacyUrl.blockers.guardDocumentsUsingLegacyExternalUrl, 1);

  console.log(JSON.stringify({ event: 'release_data_preflight_tests_passed', tests: 8 }));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
