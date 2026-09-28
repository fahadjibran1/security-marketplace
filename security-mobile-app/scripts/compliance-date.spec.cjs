/**
 * UAT-COMP-01: UK compliance expiry dates.
 *
 * Real UAT could not record an SIA / Right-to-Work expiry. The field asked for YYYY-MM-DD, a UK manager
 * typed 01/01/2028, validation refused it — and because the error was only cleared when the panel opened
 * or a file was chosen, the complaint stayed on screen while they kept correcting the value. That second
 * part is what made it feel broken rather than merely fussy.
 *
 * The parser is EXECUTED here rather than pattern-matched, because the risk is calendar arithmetic:
 * JavaScript's Date rolls 31 April into 1 May and can shift a date-only value by a day depending on the
 * runtime timezone. Both would silently corrupt a compliance expiry.
 *
 * It also pins the ISO boundary. The API and database contract is unchanged (@IsDateString accepts
 * date-only ISO), so the conversion must happen in the form and the request must carry ISO.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Shared loader: resolves relative imports between pure source modules.
const { loadTs: loadModule } = require('./load-ts.cjs');

const uk = loadModule('src/components/company/ukDate.ts');
const screening = loadModule('src/components/guard/screening-format.ts');

const drawer = read('src/components/company/ComplianceGuardDrawerBody.tsx');
const model = read('src/components/company/compliance-model.ts');

// ═══════════════════ 1-2 valid UK entry, including leap years ═══════════════════

test('COMPDATE-01-VALID-UK-DATES-ARE-ACCEPTED', () => {
  for (const [input, iso] of [
    ['01/01/2028', '2028-01-01'],
    ['31/12/2027', '2027-12-31'],
    ['28/02/2027', '2027-02-28'],
    ['30/04/2028', '2028-04-30'],
    ['31/01/2028', '2028-01-31'],
  ]) {
    assert.equal(uk.ukDateToIso(input), iso, `${input} must convert to ${iso}`);
    assert.equal(uk.isUkDate(input), true);
  }
});

test('COMPDATE-02-LEAP-YEARS-ARE-CALCULATED-NOT-GUESSED', () => {
  assert.equal(uk.ukDateToIso('29/02/2028'), '2028-02-29', '2028 is a leap year');
  assert.equal(uk.ukDateToIso('29/02/2027'), null, '2027 is not');
  // Century rules, which a naive "divisible by 4" check gets wrong.
  assert.equal(uk.isLeapYear(2000), true, '2000 is divisible by 400');
  assert.equal(uk.isLeapYear(1900), false, '1900 is a century but not divisible by 400');
  assert.equal(uk.ukDateToIso('29/02/2000'), '2000-02-29');
  assert.equal(uk.ukDateToIso('29/02/1900'), null);
  assert.equal(uk.daysInMonth(2028, 2), 29);
  assert.equal(uk.daysInMonth(2027, 2), 28);
});

// ═══════════════════ 3-4 impossible dates are rejected, never rolled over ═══════════════════

test('COMPDATE-03-IMPOSSIBLE-CALENDAR-DATES-ARE-REJECTED', () => {
  // These are the cases JavaScript's Date silently rolls forward.
  for (const bad of ['31/04/2028', '31/06/2028', '31/09/2028', '31/11/2028', '32/01/2028']) {
    assert.equal(uk.ukDateToIso(bad), null, `${bad} is not a real date and must be refused`);
  }
  // Proof the rollover really is the hazard being avoided.
  const rolled = new Date(2028, 3, 31);
  assert.equal(rolled.getMonth(), 4, 'new Date(2028, 3, 31) rolls into May — which is why Date is not used');
});

test('COMPDATE-04-INVALID-MONTH-DAY-AND-JUNK-ARE-REJECTED', () => {
  for (const bad of [
    '00/01/2028', '01/00/2028', '01/13/2028', '13/13/2028',
    '2028-01-01',            // the old ISO form is no longer a valid entry
    '01/01/28',              // two-digit years are never guessed at
    '1/1/28',
    '01-01-2028', '01.01.2028', '01/01/2028 ', // trailing space is trimmed, so this one is fine
    'tomorrow', 'abc', '', '   ', 'NaN', '01//2028', '//', '0/0/0000',
  ]) {
    const result = uk.ukDateToIso(bad);
    if (bad.trim() === '01/01/2028') { assert.equal(result, '2028-01-01', 'surrounding whitespace is trimmed'); continue; }
    assert.equal(result, null, `"${bad}" must be refused`);
  }
  assert.equal(uk.ukDateToIso(null), null);
  assert.equal(uk.ukDateToIso(undefined), null);
  // Implausible years are a typo, not a date.
  assert.equal(uk.ukDateToIso('01/01/0028'), null);
});

test('COMPDATE-05-SINGLE-DIGIT-ENTRY-IS-NORMALISED-CONSISTENTLY', () => {
  // Decided and applied consistently: 1/1/2028 means the same date and is accepted, then normalised.
  assert.equal(uk.ukDateToIso('1/1/2028'), '2028-01-01');
  assert.equal(uk.ukDateToIso('9/3/2028'), '2028-03-09');
  assert.equal(uk.normaliseUkDate('1/1/2028'), '01/01/2028');
  assert.equal(uk.normaliseUkDate('31/12/2027'), '31/12/2027');
  assert.equal(uk.normaliseUkDate('31/04/2028'), null, 'normalising never rescues an impossible date');
  // But the year is never abbreviated, so nothing is inferred.
  assert.equal(uk.ukDateToIso('1/1/28'), null);
});

// ═══════════════════ 5-6 ISO conversion, both directions, no timezone shift ═══════════════════

test('COMPDATE-06-ISO-ROUND-TRIP-IS-LOSSLESS', () => {
  for (const input of ['01/01/2028', '29/02/2028', '31/12/2027', '30/06/2029']) {
    const iso = uk.ukDateToIso(input);
    assert.equal(uk.isoToUkDate(iso), input, `${input} -> ${iso} -> back`);
  }
  assert.equal(uk.isoToUkDate('2028-01-01'), '01/01/2028');
  assert.equal(uk.isoToUkDate('2028-02-29'), '29/02/2028');
  assert.equal(uk.isoToUkDate('2027-02-29'), null, 'an impossible stored date is not displayed as real');
  assert.equal(uk.isoToUkDate('not a date'), null);
  // A full timestamp uses only its date portion.
  assert.equal(uk.isoToUkDate('2028-01-01T23:45:00.000Z'), '01/01/2028');
});

test('COMPDATE-07-A-DATE-ONLY-VALUE-NEVER-SHIFTS-BY-A-DAY', () => {
  // The conversion must be string/integer arithmetic. A Date-based implementation in a negative-offset
  // timezone turns 2028-01-01 into 31/12/2027 — this asserts the calendar date is preserved exactly.
  for (const [ukIn, iso] of [['01/01/2028', '2028-01-01'], ['31/12/2027', '2027-12-31'], ['01/07/2028', '2028-07-01']]) {
    assert.equal(uk.ukDateToIso(ukIn), iso);
    assert.equal(uk.isoToUkDate(iso), ukIn);
  }
  // Midnight and end-of-day timestamps land on the same calendar day.
  assert.equal(uk.isoToUkDate('2028-01-01T00:00:00Z'), '01/01/2028');
  assert.equal(uk.isoToUkDate('2028-01-01T23:59:59Z'), '01/01/2028');
  // No Date construction anywhere in the module.
  const source = read('src/components/company/ukDate.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(source, /new Date\(/, 'the parser must not construct a Date');
  assert.doesNotMatch(source, /Date\.parse|toISOString|getTimezoneOffset/, 'nor rely on any Date behaviour');
});

// ═══════════════════ 7 the two UK parsers must not drift apart ═══════════════════

test('COMPDATE-08-AGREES-WITH-THE-EXISTING-SCREENING-PARSER', () => {
  // screening-format.ts already had a UK parser for the Guard screening journey. That journey is out of
  // scope to refactor here, so this pins the two to the same answers: if either changes, this fails.
  const tryScreening = (value) => { try { return screening.screeningDateToIso(value); } catch { return null; } };
  for (const value of ['01/01/2028', '31/12/2027', '29/02/2028', '29/02/2027', '31/04/2028', '00/01/2028', '01/13/2028', 'abc', '2028-01-01']) {
    assert.equal(uk.ukDateToIso(value), tryScreening(value), `both parsers must agree on "${value}"`);
  }
  // And the shared display direction agrees too.
  assert.equal(uk.isoToUkDate('2028-01-01'), screening.formatScreeningDate('2028-01-01'));
});

// ═══════════════════ 8 the error clears when the field is corrected ═══════════════════

test('COMPDATE-09-A-STALE-ERROR-CLEARS-AS-SOON-AS-THE-FIELD-IS-EDITED', () => {
  // The precise UAT complaint: the error persisted while a legitimate value was being typed.
  const expiryField = /value=\{uploadExpiry\}[\s\S]{0,700}?\/>/.exec(drawer);
  assert.ok(expiryField, 'the upload expiry field exists');
  assert.match(
    expiryField[0],
    /onChangeText=\{\(next: string\) => \{ setUploadExpiry\(next\); if \(uploadError\) setUploadError\(null\); \}\}/,
    'editing the expiry clears a previous error',
  );
  for (const [state, setter] of [['recordIssue', 'setRecordIssue'], ['recordExpiry', 'setRecordExpiry']]) {
    const field = new RegExp(`value=\\{${state}\\}[\\s\\S]{0,700}?/>`).exec(drawer);
    assert.ok(field, `${state} field exists`);
    assert.match(field[0], new RegExp(`${setter}\\(next\\); if \\(recordError\\) setRecordError\\(null\\);`), `${state} clears its error too`);
  }
});

// ═══════════════════ 9-10 SIA and RTW both send ISO ═══════════════════

test('COMPDATE-10-THE-UPLOAD-REQUEST-CARRIES-ISO-FOR-BOTH-DOCUMENT-TYPES', () => {
  // SIA and Right-to-Work share ONE upload panel — verified, not assumed: the type is a chip value
  // passed straight through, and the expiry handling is common to both.
  const submit = /const submitUpload = async \(\) => \{([\s\S]*?)\n  \};/.exec(drawer);
  assert.ok(submit, 'submitUpload exists');
  assert.match(submit[1], /const isoExpiry = typedExpiry \? ukDateToIso\(typedExpiry\) : '';/, 'UK is converted to ISO');
  assert.match(submit[1], /if \(typedExpiry && isoExpiry === null\)[\s\S]{0,80}UK_DATE_ERROR/, 'a bad date is refused locally');
  assert.match(submit[1], /onUploadDocument\(\{ type: uploadType, file: uploadFile, expiryDate: isoExpiry \?\? '' \}\)/, 'the request carries ISO');
  assert.doesNotMatch(submit[1], /expiryDate: uploadExpiry/, 'the raw UK text is never sent');
  // One panel, both types.
  assert.match(drawer, /const \[uploadType, setUploadType\] = React\.useState<string>\('sia_licence'\)/);
  assert.match(drawer, /active=\{uploadType === option\.value\}/, 'the type is chosen by chip in the same panel');
  assert.ok(drawer.includes('UPLOAD_DOCUMENT_TYPES'), 'from the shared type list');
  const types = /UPLOAD_DOCUMENT_TYPES[^=]*=\s*\[([\s\S]*?)\]/.exec(model);
  assert.ok(types && /sia_licence/.test(types[1]) && /right_to_work/.test(types[1]), 'which covers SIA and RTW');
});

test('COMPDATE-11-THE-RECORD-REQUEST-CARRIES-ISO-AND-OPENS-IN-UK', () => {
  const submit = /const submitRecord = async \(\) => \{([\s\S]*?)\n  \};/.exec(drawer);
  assert.ok(submit, 'submitRecord exists');
  assert.match(submit[1], /const isoExpiry = ukDateToIso\(recordExpiry\.trim\(\)\);/);
  assert.match(submit[1], /if \(isoExpiry === null\) return setRecordError\(UK_DATE_ERROR\);/);
  assert.match(submit[1], /expiryDate: isoExpiry,/, 'ISO is sent');
  assert.match(submit[1], /issueDate: isoIssue,/, 'including the optional issue date');
  assert.doesNotMatch(submit[1], /expiryDate: recordExpiry/, 'never the raw UK text');
  // An existing record is stored as ISO and must open in the format it is edited in.
  const open = /const openRecord = \(type: RecordType\) => \{([\s\S]*?)\n  \};/.exec(drawer);
  assert.match(open[1], /setRecordExpiry\(isoToUkDate\(existing\?\.expiryDate\) \?\? ''\)/);
  assert.match(open[1], /setRecordIssue\(isoToUkDate\(existing\?\.issueDate\) \?\? ''\)/);
});

// ═══════════════════ 11 display, and no ISO shown to the user ═══════════════════

test('COMPDATE-12-SAVED-EXPIRY-DATES-DISPLAY-AS-DD-MM-YYYY', () => {
  assert.equal(uk.formatUkDate('2028-01-01'), '01/01/2028');
  assert.equal(uk.formatUkDate(null), '—');
  assert.equal(uk.formatUkDate(''), '—');
  assert.equal(uk.formatUkDate('rubbish'), 'rubbish', 'unrecognised stored data stays visible, not hidden');
  // The drawer renders expiries through the UK formatter.
  for (const expr of [
    'formatUkDate(summary.siaExpiryDate)',
    'formatUkDate(summary.rightToWorkExpiryDate)',
    'Expiry {formatUkDate(document.expiryDate)}',
    'Expiry {formatUkDate(record.expiryDate)}',
  ]) {
    assert.ok(drawer.includes(expr), `expiry display uses the UK formatter: ${expr}`);
  }
  // Compliance expiry indicators too.
  assert.match(model, /const date = formatUkDate\(expiry\);/);
});

test('COMPDATE-13-NO-ISO-FORMAT-IS-EXPOSED-TO-THE-COMPLIANCE-USER', () => {
  assert.equal(uk.UK_DATE_PLACEHOLDER, 'DD/MM/YYYY');
  assert.equal(uk.UK_DATE_ERROR, 'Enter a valid date in DD/MM/YYYY format.');
  assert.doesNotMatch(uk.UK_DATE_ERROR, /YYYY-MM-DD/, 'the error never mentions the internal format');
  // No ISO placeholder or message survives in the compliance drawer or its model.
  for (const [label, source] of [['drawer', drawer], ['model', model]]) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /YYYY-MM-DD/, `${label} exposes no ISO format to the user`);
  }
  assert.ok(drawer.includes('placeholder={UK_DATE_PLACEHOLDER}'), 'the fields prompt in UK format');
  assert.match(drawer, /helperText=\{`Use \$\{UK_DATE_PLACEHOLDER\}, for example 01\/01\/2028\.`\}/, 'with a worked example');
});

// ═══════════════════ 12 the rest of the journey is untouched ═══════════════════

test('COMPDATE-14-THE-UPLOAD-AND-VERIFY-FLOW-IS-OTHERWISE-INTACT', () => {
  // File choice, size/type validation, the verification action and the private-evidence view are all
  // unchanged; only the date handling moved.
  assert.ok(drawer.includes('onPickDocument'), 'file picking is unchanged');
  assert.ok(drawer.includes('onRequestVerification'), 'verification is unchanged');
  assert.ok(drawer.includes('validateUpload'), 'size/type validation still runs');
  assert.match(model, /if \(!input\.size \|\| input\.size < 1\) return/, 'empty files still refused');
  assert.match(model, /MAX_EVIDENCE_BYTES/, 'the 10 MB limit still applies');
  assert.match(model, /normalizeEvidenceMimeType/, 'PDF/JPEG/PNG still enforced');
  // The ISO contract guard remains as a boundary check on the converted value.
  assert.match(model, /if \(expiry && !isIsoDate\(expiry\)\) return UK_DATE_ERROR;/);
  assert.match(model, /export function isIsoDate/, 'the ISO checker is retained for that boundary');
});

test('COMPDATE-15-THE-SHARED-DATE-FORMATTER-IS-NOT-REWRITTEN-PLATFORM-WIDE', () => {
  // formatDate is imported by Finance, Coverage, Availability and Contract Pricing; changing it was out
  // of scope, so it must still render the long UK form it always did.
  const model2 = loadModule('src/components/company/compliance-model.ts');
  assert.equal(model2.formatDate('2028-01-01'), '1 Jan 2028', 'formatDate is unchanged');
  assert.match(model, /toLocaleDateString\('en-GB', \{ day: 'numeric', month: 'short', year: 'numeric' \}\)/);
  // Timestamps in the drawer still use it; only expiry dates moved to the UK formatter.
  assert.ok(drawer.includes('Uploaded {formatDate(document.uploadedAt)}'), 'upload timestamps unchanged');
});

console.log(`\n${passed} compliance date checks passed`);
