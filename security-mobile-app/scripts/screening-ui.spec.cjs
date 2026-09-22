const assert=require('assert'),fs=require('fs'),path=require('path');let passed=0;
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const panel=read('src/components/guard/GuardScreeningPanel.tsx'),formatSource=read('src/components/guard/screening-format.ts'),guard=read('src/screens/GuardDashboardScreen.tsx'),jobs=read('src/screens/JobsScreen.tsx'),admin=read('src/screens/AdminDashboardScreen.tsx'),company=read('src/components/company/CompanyComplianceWorkspace.tsx'),api=read('src/services/api.ts'),models=read('src/types/models.ts'),service=read('../security-backend-nest/src/screening/screening.service.ts'),controller=read('../security-backend-nest/src/screening/screening.controller.ts'),eligibility=read('../security-backend-nest/src/compliance/compliance.service.ts');
const compiled=require('typescript').transpileModule(formatSource,{compilerOptions:{module:require('typescript').ModuleKind.CommonJS,target:require('typescript').ScriptTarget.ES2022}}).outputText,dateExports={};new Function('exports',compiled)(dateExports);
function test(name,fn){fn();passed++;console.log(`PASS ${name}`)}
test('ACTIVE unvetted Guard sees screening progress',()=>assert.match(panel,/Marketplace access: Available[\s\S]*Work eligibility:/));
test('ACTIVE unvetted Guard still sees Jobs',()=>assert.match(guard,/\['jobs', 'Jobs'\]/));
test('ACTIVE unvetted Guard can still apply',()=>{assert.doesNotMatch(jobs,/VETTED|screening/i);assert.match(jobs,/appl/i)});
test('dedicated screening navigation works',()=>{assert.match(guard,/activeTab === 'screening'/);assert.match(panel,/STEPS\.map/)});
test('progress reflects backend response',()=>assert.match(panel,/data\.progress/));
test('personal details can be saved',()=>assert.match(panel,/updateMyScreeningProfile\(/));
test('address history can be maintained',()=>assert.match(panel,/addMyScreeningAddress/));
test('activity chronology can be maintained',()=>assert.match(panel,/addMyScreeningHistory/));
test('backend-detected gap is displayed',()=>assert.match(panel,/requirements\?\.chronology\.gaps/));
test('backend-detected overlap is displayed',()=>assert.match(panel,/requirements\?\.chronology\.overlaps/));
test('references can be maintained',()=>assert.match(panel,/addMyScreeningReference/));
test('evidence workflow uses signed private upload',()=>{assert.match(panel,/created\.upload\.url/);assert.match(panel,/completeMyScreeningEvidence/);assert.match(service,/createSignedUploadUrl/)});
test('Guard cannot self-verify evidence',()=>assert.doesNotMatch(panel,/verifyScreeningCheck/));
test('Guard cannot self-mark VETTED',()=>assert.doesNotMatch(panel,/status\s*:\s*['"]VETTED/));
test('consent acceptance works',()=>assert.match(panel,/acceptMyScreeningConsent/));
test('consent withdrawal works',()=>assert.match(panel,/withdrawMyScreeningConsent/));
test('submission displays missing requirements',()=>assert.match(panel,/requirements\?\.missing\.map/));
for(const status of ['READY_FOR_REVIEW','UNDER_REVIEW','VETTED','REQUIRES_ATTENTION','REJECTED','EXPIRED'])test(`${status} has a human-readable presentation`,()=>assert.match(panel,new RegExp(`${status}:\\s*["'][^"']+["']`)));
test('company cannot access private screening information',()=>{assert.doesNotMatch(company,/screening\/evidence|dateOfBirth|reviewNotes|storageKey|signedUrl/);assert.match(service,/companyOutcome/)});
test('company-safe outcome remains minimal',()=>assert.match(service,/return \{guardId,status:s\?\.status\?\?ScreeningStatus\.NOT_STARTED,vetted:/));
test('reviewer authorization remains ADMIN-only',()=>assert.match(controller,/@Roles\(UserRole\.ADMIN\)[\s\S]*start-review/));
test('Admin reviewer sees chronology and gaps',()=>{assert.match(admin,/Activity chronology/);assert.match(admin,/Unexplained period/)});
test('Admin reviewer does not render private storage values',()=>assert.doesNotMatch(admin,/storageKey|signedUrl|upload\.url/));
test('suspended and inactive account eligibility remains fail-closed',()=>assert.match(eligibility,/UserStatus\.ACTIVE/));
test('unvetted hiring remains server-blocked',()=>assert.match(eligibility,/isGuardVetted|screening/i));
test('vetted compliant ACTIVE eligibility path remains server-derived',()=>{assert.match(eligibility,/UserStatus\.ACTIVE/);assert.match(eligibility,/compliance/i);assert.match(eligibility,/screening|VETTED/i)});
test('profile contains compact summary, not workflow form',()=>{assert.match(panel,/YOUR VETTING & SCREENING/);assert.match(guard,/GuardScreeningPanel onContinue/)});
test('SIA and Right to Work are distinct checks',()=>{assert.match(panel,/SIA register verification/);assert.match(panel,/Right to Work verification/)});
test('verification language separates upload and review',()=>assert.match(panel,/Upload never means verified/));
test('explicit labels and controlled feedback are present',()=>{assert.match(panel,/accessibilityLabel=\{label\}/);assert.match(panel,/Personal details saved/);assert.match(panel,/accessibilityRole=["']alert["']/)});
test('responsive step navigation avoids a desktop-only form',()=>assert.match(panel,/ScrollView[\s\S]{0,100}horizontal/));
test('API exposes no client VETTED mutation',()=>assert.doesNotMatch(api,/status\s*:\s*['"]VETTED|setVetted/));
test('model includes server consent and verification state',()=>{assert.match(models,/consents\?/);assert.match(models,/identityVerification\?/)});
test('API ISO renders DD/MM/YYYY',()=>assert.equal(dateExports.formatScreeningDate('1947-08-14'),'14/08/1947'));
test('DD/MM/YYYY converts to API ISO',()=>assert.equal(dateExports.screeningDateToIso('01/01/2024'),'2024-01-01'));
test('invalid calendar date is rejected',()=>assert.throws(()=>dateExports.screeningDateToIso('31/02/2025'),/valid date/));
test('valid leap date is accepted',()=>assert.equal(dateExports.screeningDateToIso('29/02/2024'),'2024-02-29'));
test('invalid non-leap date is rejected',()=>assert.throws(()=>dateExports.screeningDateToIso('29/02/2025'),/valid date/));
test('postcode is normalized for persistence',()=>assert.equal(dateExports.normalizeScreeningPostcode('  sw1a1aa '),'SW1A 1AA'));
test('invalid postcode is rejected',()=>assert.throws(()=>dateExports.normalizeScreeningPostcode('ABC'),/valid UK postcode/));
test('no ISO candidate labels remain',()=>{assert.doesNotMatch(panel,/\(YYYY-MM-DD\)/);assert.doesNotMatch(panel,/toLocaleDateString/)});
test('address five-year coverage is server authoritative',()=>{assert.match(panel,/addressChronology/);assert.match(service,/addressChronology=assessContinuousHistory/)});
test('activity five-year coverage supports all certified period types',()=>{for(const value of ['EMPLOYMENT','SELF_EMPLOYMENT','EDUCATION','UNEMPLOYMENT','CAREER_BREAK','OVERSEAS','OTHER_EXPLAINED_PERIOD'])assert.match(panel,new RegExp(value))});
test('exact address and activity gaps are actionable',()=>{assert.match(panel,/ADDRESS HISTORY INCOMPLETE — MISSING PERIOD/);assert.match(panel,/ACTIVITY HISTORY INCOMPLETE — MISSING PERIOD/);assert.match(panel,/dateLabel\(from\)/)});
test('reference linkage uses owned activity selector',()=>{assert.match(panel,/data\.history\.map/);assert.doesNotMatch(panel,/Activity record ID/);assert.match(service,/history\.screening\.id!==screening\.id/)});
test('document picker drives private upload flow',()=>{assert.match(panel,/DocumentPicker\.getDocumentAsync/);assert.match(service,/createSignedUploadUrl/)});
test('cancelled document picker is safe',()=>assert.match(panel,/if \(result\.canceled\) return/));
test('picker accepts PDF JPEG and PNG',()=>{for(const mime of ['application/pdf','image/jpeg','image/png'])assert.match(panel,new RegExp(mime.replace('/','\\/')))});
test('invalid MIME is rejected',()=>assert.match(panel,/Choose a PDF, JPEG\/JPG or PNG document/));
test('oversized evidence is rejected before metadata creation',()=>assert.ok(panel.indexOf('10 MB size limit')<panel.lastIndexOf('createMyScreeningEvidence')));
test('evidence selection uploads immediately and never leaks the URI',()=>{assert.match(panel,/Choose document/);assert.match(panel,/Choosing a document uploads it straight away/);assert.doesNotMatch(panel,/Selected file URI/)});
test('step navigation clears stale mutation errors',()=>{assert.match(panel,/navigateToStep/);assert.match(panel,/setError\(""\)/)});
test('progress uses authoritative candidate criteria',()=>assert.match(service,/candidateCriteria/));
test('multiple address UX uses structured fields and readable cards',()=>{for(const label of ['Address line 1 *','Address line 2 (optional)','Town / City *','Postcode *','+ Add another address','Verification:'])assert.ok(panel.includes(label));assert.match(models,/addressLine1\?/)});
test('current address control separates Present from end date',()=>{assert.match(panel,/I currently live at this address/);assert.match(panel,/address\.isCurrent/)});
test('multiple activity UX uses backend enum choices',()=>{assert.match(panel,/\+ Add another activity/);assert.match(panel,/activityOrganisationLabel/);for(const value of ['EMPLOYMENT','SELF_EMPLOYMENT','EDUCATION','UNEMPLOYMENT','CAREER_BREAK','OVERSEAS','OTHER_EXPLAINED_PERIOD'])assert.match(panel,new RegExp(value))});
test('activity cards retain human-readable dates',()=>assert.match(panel,/pretty\(h\.type\)[\s\S]*h\.organisation[\s\S]*dateLabel\(h\.startDate\)/));
test('Personal Details has no editable current address',()=>{assert.doesNotMatch(panel,/label="Current address"/);assert.doesNotMatch(panel,/profile\.currentAddress/)});
test('Address History is the only authoritative residential source',()=>{assert.match(service,/addressChronology=assessContinuousHistory\(s\.addresses/);assert.doesNotMatch(service,/nationality&&!!s\.currentAddress/)});
test('new address flow always starts blank and non-current',()=>{assert.match(panel,/emptyAddressForm[^\n]*addressLine1: ""[^\n]*postcode: ""[^\n]*isCurrent: false/);assert.match(panel,/setAddress\(emptyAddressForm\(\)\); setShowAddressForm\(true\)/)});
test('successful address save resets and closes create mode',()=>assert.match(panel,/Address history updated[^\n]*setAddress\(emptyAddressForm\(\)\); setShowAddressForm\(false\)/));
test('aggregate refresh does not hydrate transient address state',()=>{const loadBody=panel.split('const load = React.useCallback')[1].split('React.useEffect')[0];assert.doesNotMatch(loadBody,/setAddress|setHistory/)});
test('new activity flow always starts blank with no type',()=>{assert.match(panel,/emptyActivityForm[^\n]*type: ""[^\n]*organisation: ""[^\n]*description: ""/);assert.match(panel,/setHistory\(emptyActivityForm\(\)\); setShowHistoryForm\(true\)/)});
test('successful activity save resets and closes create mode',()=>assert.match(panel,/Activity history updated[\s\S]{0,160}setHistory\(emptyActivityForm\(\)\); setShowHistoryForm\(false\)/));
test('create forms support non-mutating cancel',()=>{assert.match(panel,/label="Cancel"/);assert.match(panel,/setShowAddressForm\(false\)/);assert.match(panel,/setShowHistoryForm\(false\)/)});
test('progress does not double-count legacy currentAddress',()=>{const criteria=service.split('const candidateCriteria=')[1].split(';const progress')[0];assert.doesNotMatch(criteria,/currentAddress/);assert.match(criteria,/req\.addressChronology\.continuous/)});

// ── Android owner UAT fix pack ────────────────────────────────────────────────────────────────
const ts=require('typescript');
const toJs=src=>ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const ninoFn=new Function(toJs(guard.match(/function isValidNinoFormat[\s\S]*?\n  \}/)[0])+';return isValidNinoFormat;')();
const sectionStatusFn=new Function('data',toJs(panel.match(/const sectionStatus = \(stepKey: string\)[\s\S]*?\n  \};/)[0])+';return sectionStatus;');
const withRemediation=(rows,step='addresses')=>sectionStatusFn({requirements:{remediation:rows}})(step);

test('NINO-COMPACT',()=>assert.equal(ninoFn('AB123456C'),true));
test('NINO-SPACED',()=>assert.equal(ninoFn('AB 12 34 56 C'),true));
test('NINO-LOWERCASE',()=>{assert.equal(ninoFn('ab123456c'),true);assert.equal(ninoFn('ab 12 34 56 c'),true)});
test('NINO-INVALID-SUFFIX',()=>{assert.equal(ninoFn('AB123456X'),false);assert.equal(ninoFn('AB 12 34 56 X'),false)});
test('NINO-FIELD-FITS-DOCUMENTED-FORMAT',()=>{const m=guard.match(/maxLength=\{(\d+)\}[\s\S]{0,80}autoFocus/);assert.ok(m,'NINO maxLength not found');assert.ok(Number(m[1])>='AB 12 34 56 C'.length,'maxLength truncates the documented format')});
test('NINO-COPY-EXPLAINS-SUFFIX',()=>{const copy=guard.split('setNinoInputError(')[1].split(');')[0];assert.match(copy,/must be A, B, C or D/);assert.doesNotMatch(copy,/\[A-|\d\{|regex/i,'user copy must not expose the implementation regex')});
test('NINO-BACKEND-VALIDATION-UNCHANGED',()=>assert.match(read('../security-backend-nest/src/guard-personnel/guard-personnel.service.ts'),/\[A-D\]\$/));

test('ADDRESS-REMEDIATION-NO-CRASH',()=>{const body=panel.split('const navigateToRemediation')[1].split('};')[0];assert.match(body,/try \{/);assert.match(body,/catch \{\}/);assert.doesNotMatch(body,/stage\.measureLayout\(sv as any/)});
test('ADDRESS-VALIDATION-NO-CRASH',()=>{const save=panel.split('label={editingAddressId?"Save address changes":"Save address"}')[1].split('/>')[0];assert.ok(save.includes('act('),'address save must go through act()');assert.ok(save.indexOf('act(')<save.indexOf('normalizeScreeningPostcode'),'postcode parsing must run inside act()');assert.ok(save.indexOf('act(')<save.indexOf('screeningDateToIso'),'date parsing must run inside act()')});
test('ACTIVITY-VALIDATION-NO-CRASH',()=>{const save=panel.split('label={editingHistoryId?"Save activity changes":"Save activity"}')[1].split('\n            />')[0];assert.ok(save.indexOf('act(')<save.indexOf('screeningDateToIso'),'date parsing must run inside act()')});
test('VALIDATION-ERRORS-STILL-THROW',()=>{assert.throws(()=>dateExports.screeningDateToIso(''),/DD\/MM\/YYYY/);assert.throws(()=>dateExports.normalizeScreeningPostcode(''),/valid UK postcode/)});

test('CONSENT-INCOMPLETE-ACCEPT',()=>{const consent=panel.split('{step === "consent" ?')[1].split('{step === "review" ?')[0];const notAccepted=consent.split('return (')[2];assert.match(notAccepted,/Accept consent & declaration/)});
test('CONSENT-COMPLETE-NO-REACCEPT',()=>{const consent=panel.split('{step === "consent" ?')[1].split('{step === "review" ?')[0];const accepted=consent.split('if (current)')[1].split('return (')[1];assert.doesNotMatch(accepted,/Accept consent & declaration/);assert.match(accepted,/Accepted/);assert.match(accepted,/Withdraw consent/)});
test('CONSENT-METADATA-SHOWN',()=>assert.match(panel,/acceptedAt[\s\S]{0,140}consentVersion/));

test('ADDRESS-COMPLETE',()=>{assert.match(panel,/requirementStatus\("address_history"\) === "COMPLETE"/);assert.match(panel,/Address history complete/);assert.match(panel,/do not need to add your current address again/)});
test('ACTIVITY-COMPLETE',()=>{assert.match(panel,/requirementStatus\("activity_history"\) === "COMPLETE"/);assert.match(panel,/Activity history complete/)});
test('STEP-COMPLETE',()=>{assert.equal(withRemediation([{step:'addresses',status:'COMPLETE'}]),'COMPLETE');assert.equal(withRemediation([{step:'identity',status:'VERIFIED'}],'identity'),'VERIFIED');assert.match(panel,/done \? "✓" : i \+ 1/)});
test('STEP-AWAITING',()=>{assert.equal(withRemediation([{step:'addresses',status:'COMPLETE'},{step:'addresses',status:'AWAITING_VERIFICATION'}]),'AWAITING_VERIFICATION');assert.match(panel,/Awaiting check/)});
test('STEP-ACTION-REQUIRED',()=>{assert.equal(withRemediation([{step:'addresses',status:'AWAITING_VERIFICATION'},{step:'addresses',status:'ACTION_REQUIRED'}]),'ACTION_REQUIRED');assert.equal(withRemediation([]),null)});
test('STEP-STATUS-IS-BACKEND-DERIVED',()=>{assert.match(panel,/requirements\?\.remediation \|\| \[\]/);assert.doesNotMatch(panel,/localCompleted|completedSteps|setCompleted/)});

test('PICKER-CANCEL',()=>{const choose=panel.split('const choose = async ()')[1].split('const upload = async ()')[0];assert.match(choose,/if \(result\.canceled\) return;/);const cancelIdx=choose.indexOf('result.canceled');assert.ok(choose.slice(cancelIdx,cancelIdx+60).indexOf('setUploadError')===-1,'cancel must be a quiet return')});
test('PICKER-ERROR',()=>{const choose=panel.split('const choose = async ()')[1].split('const upload = async ()')[0];assert.match(choose,/try \{[\s\S]*getDocumentAsync[\s\S]*\} catch \{/);assert.match(choose,/document picker could not be opened/)});

test('NATIVE-UPLOAD',()=>{const up=panel.split('const uploadEvidence = async')[1].split('const categorizeUploadError')[0];assert.match(up,/new Blob\(\[raw\], \{ type: mimeType \}\)/,'blob must carry the signed content type');assert.ok(up.indexOf('new Blob')<up.indexOf('createMyScreeningEvidence')||up.includes('body,'),'signed type must be applied to the uploaded body');assert.match(up,/const sizeBytes = raw\.size/,'declared size must be the real byte count');assert.match(up,/Unable to read the selected file/);assert.match(up,/Network unavailable/);assert.match(up,/Upload failed/);assert.match(up,/Upload verification failed/)});
test('NATIVE-UPLOAD-BACKEND-UNCHANGED',()=>{const store=read('../security-backend-nest/src/compliance/evidence-storage.service.ts');assert.match(store,/'content-type': object\.mimeType/,'content-type must remain a signed header');assert.match(store,/size !== expectedSizeBytes \|\| mimeType !== object\.mimeType/,'server-side verification must not be weakened')});
test('NATIVE-UPLOAD-NO-SECRET-LEAK',()=>{const picker=panel.split('function EvidencePicker')[1];assert.doesNotMatch(picker,/upload\.url|storageKey|X-Amz/)});


console.log(JSON.stringify({event:'screening_ux_tests_passed',tests:passed}));
