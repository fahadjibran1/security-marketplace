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
test('activity cards retain human-readable dates',()=>assert.match(panel,/historyTypeLabel\(h\.type\)[\s\S]*h\.organisation[\s\S]*dateLabel\(h\.startDate\)/));
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
test('NINO-COPY-EXPLAINS-SUFFIX',()=>{const copy=guard.split('setNinoInputError(')[1].split(');')[0];assert.match(copy,/A, B, C or D/);assert.doesNotMatch(copy,/\[A-|\d\{|regex/i,'user copy must not expose the implementation regex')});
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



// ── Owner UAT round 2: tabs, section action hierarchy, NINO input ─────────────────────────────
const ninoFmt=new Function(toJs(guard.match(/function formatNinoInput[\s\S]*?\n  \}/)[0])+';return formatNinoInput;')();

test('TAB-ACTIVE-DURING-SCREENING',()=>{assert.match(guard,/const navActiveTab: GuardTab = activeTab === 'screening' \? 'profile' : activeTab;/);assert.match(guard,/accessibilityState=\{\{ selected: navActiveTab === tab \}\}/);assert.doesNotMatch(guard,/accessibilityState=\{\{ selected: activeTab === tab \}\}/)});
test('TAB-SCROLL-RESET',()=>{const fn=guard.split('const selectTab = useCallback')[1].split('}, \[\]);')[0];assert.match(fn,/setActiveTab\(tab\)/);assert.match(fn,/scrollTo\(\{ y: 0, animated: false \}\)/);assert.match(fn,/catch/,'scroll reset must never break navigation')});
test('TAB-ALL-FIVE-USE-SELECT',()=>{const nav=guard.split('styles.bottomNav,')[1].split('</View>')[0];assert.match(nav,/onPress=\{\(\) => selectTab\(tab\)\}/);assert.doesNotMatch(nav,/onPress=\{\(\) => setActiveTab\(tab\)\}/)});
test('TAB-SCREENING-ENTRY-RESETS',()=>{assert.match(guard,/onContinue=\{\(\) => selectTab\('screening'\)\}/);assert.match(guard,/onBack=\{\(\) => selectTab\('profile'\)\}/);assert.match(guard,/onManageCompliance=\{\(\) => selectTab\('screening'\)\}/)});

test('EVIDENCE-ONE-DOCUMENT-RULE',()=>{const svc=read('../security-backend-nest/src/screening/screening.service.ts');assert.match(svc,/if\(!records\.length\)missing\.push/,'exactly one completed upload clears the requirement');assert.match(svc,/const uploadedEvidence=\(category:string\)=>\(s\.evidence\|\|\[\]\)\.filter\(e=>String\(e\.category\)===category&&!!e\.uploadCompletedAt\)/)});
test('EVIDENCE-VERIFICATION-DOES-NOT-BLOCK-SUBMIT',()=>{const svc=read('../security-backend-nest/src/screening/screening.service.ts');const req=svc.split('private requirements(')[1].split('private view(')[0];for(const key of ['identity_check','sia_check','rtw_check','sia_expiry','rtw_status']){const seg=req.split("add('"+key+"'")[1].split(';')[0];assert.doesNotMatch(seg||'',/missing\.push/,key+' must not block submit')}});

test('IDENTITY-SETTLED-DEMOTES-CTA',()=>{const idStep=panel.split('{step === "identity" ?')[1].split('{step === "addresses" ?')[0];assert.match(idStep,/SectionState/);assert.match(idStep,/variant=\{evidenceSettled\("identity"\) \? "secondary" : "primary"\}/);assert.match(idStep,/Add another identity document/);assert.match(idStep,/One identity document is all that is required/)});
test('SIA-SETTLED-DEMOTES-CTA',()=>{const st=panel.split('{step === "checks" ?')[1].split('{step === "evidence" ?')[0];assert.match(st,/variant=\{evidenceSettled\("sia"\) \? "secondary" : "primary"\}/);assert.match(st,/requirementStatus\("sia_expiry"\)/)});
test('RTW-SETTLED-DEMOTES-CTA',()=>{const st=panel.split('{step === "checks" ?')[1].split('{step === "evidence" ?')[0];assert.match(st,/variant=\{evidenceSettled\("right_to_work"\) \? "secondary" : "primary"\}/);assert.match(st,/requirementStatus\("rtw_status"\)/)});
test('ADDRESS-ADD-IS-SECONDARY-WHEN-COMPLETE',()=>assert.match(panel,/variant=\{requirementStatus\("address_history"\) === "COMPLETE" \? "secondary" : "primary"\}/));
test('ACTIVITY-ADD-IS-SECONDARY-WHEN-COMPLETE',()=>assert.match(panel,/variant=\{requirementStatus\("activity_history"\) === "COMPLETE" \? "secondary" : "primary"\}/));
test('SUPPORTING-EVIDENCE-IS-OPTIONAL',()=>{const ev=panel.split('{step === "evidence" ?')[1].split('{step === "consent" ?')[0];assert.match(ev,/Optional supporting evidence/);assert.match(ev,/Nothing here is required to submit/);assert.match(ev,/variant="secondary"/)});
test('REVIEW-PLAIN-LANGUAGE-STATUS',()=>{const rv=panel.split('function Review(')[1];for(const word of ['Verified','Complete','Awaiting verification','Action required'])assert.ok(rv.includes(word),'missing '+word);assert.match(rv,/'⏳'/);assert.doesNotMatch(rv,/item\.status\.replaceAll/,'raw enum must not be shown to the Guard')});
test('SECTION-STATE-IS-BACKEND-DRIVEN',()=>{const comp=panel.split('function SectionState(')[1].split('function PeriodGuidance')[0];assert.match(comp,/ACTION_REQUIRED/);assert.match(comp,/AWAITING_VERIFICATION/);assert.match(comp,/VERIFIED/);assert.doesNotMatch(panel,/localCompleted|completedSteps|setCompleted/)});

test('NINO-FORMAT-COMPACT-PASTE',()=>assert.equal(ninoFmt('QQ123456C'),'QQ 12 34 56 C'));
test('NINO-FORMAT-LOWERCASE',()=>assert.equal(ninoFmt('qq123456c'),'QQ 12 34 56 C'));
test('NINO-FORMAT-ALREADY-SPACED',()=>assert.equal(ninoFmt('QQ 12 34 56 C'),'QQ 12 34 56 C'));
test('NINO-FORMAT-PARTIAL',()=>{assert.equal(ninoFmt('Q'),'Q');assert.equal(ninoFmt('QQ12'),'QQ 12')});
test('NINO-FORMAT-STRIPS-JUNK',()=>assert.equal(ninoFmt('qq-12/34.56 c'),'QQ 12 34 56 C'));
test('NINO-EXAMPLE-IS-NEUTRAL-AND-VALID',()=>{const ninoBlock=guard.split('National Insurance Number')[1].split('maxLength={13}')[0];const ph=ninoBlock.split('placeholder="')[1].split('"')[0];assert.equal(ph,'Example: AB 12 34 56 C');assert.doesNotMatch(ph,/QQ/,'the example must not use an unissuable prefix');assert.equal(ninoFn(ph.replace('Example: ','')),true,'a Guard who types the example verbatim must be accepted')});
test('NINO-COPY-IS-PLAIN-ENGLISH',()=>{const copy=guard.split('setNinoInputError(')[1].split(');')[0];assert.match(copy,/HMRC letter, payslip or P60/);assert.match(copy,/2 letters, 6 numbers/);assert.match(copy,/A, B, C or D/)});
test('NINO-PREFIX-VARIETY',()=>{for(const n of ['AB123456A','JR501234D','SW123456B','EH123456C','ZY123456A','KL123456D'])assert.equal(ninoFn(n),true,n+' should be valid')});
test('NINO-EXAMPLE-PREFIX-IS-UNISSUABLE',()=>{assert.equal(ninoFn('QQ123456C'),false,'QQ is deliberately never issued by HMRC, which is why it is safe as an example');for(const letter of ['D','F','I','Q','U','V'])assert.equal(ninoFn(letter+'A123456C'),false,letter+' must never be accepted as a first letter')});
test('NINO-PREFIX-RESTRICTIONS-KEPT',()=>{for(const n of ['BG123456A','GB123456A','NK123456A','KN123456A','TN123456A','NT123456A','ZZ123456A'])assert.equal(ninoFn(n),false,n+' prefix must stay rejected')});
test('NINO-SUFFIX-ONLY-ABCD',()=>{for(const ok of ['AB123456A','AB123456B','AB123456C','AB123456D'])assert.equal(ninoFn(ok),true,ok);for(const bad of ['AB123456E','AB123456X','AB123456Z','AB1234561'])assert.equal(ninoFn(bad),false,bad)});
test('NINO-FORMATTER-NEVER-VALIDATES',()=>{const fn=guard.split('function formatNinoInput')[1].split('\n  }')[0];assert.doesNotMatch(fn,/A-CEGHJ|BG|test\(/,'formatter must not duplicate the authoritative rule')});


// ── Round 3: screening continuity across Android background / foreground ─────────────────────
// The journey keeps step and unsaved form input in component state, so ANY unmount of the
// dashboard subtree silently discards them. These lock the mount down.
test('CONTINUITY-LOADING-GATE-IS-FIRST-LOAD-ONLY',()=>{
  const gate=guard.split('if (loading &&')[1].split('}')[0];
  assert.match(gate,/!hasLoadedOnceRef\.current/,'refreshes must not replace the mounted tree');
  assert.match(guard,/hasLoadedOnceRef\.current = true;/,'the flag must be set once a load settles');
  const fin=guard.split('async function loadData')[1].split('async function handlePullRefresh')[0].split('} finally {')[1];
  assert.ok(fin.indexOf('hasLoadedOnceRef.current = true')<fin.indexOf('setLoading(false)'),'flag must be set before loading clears, or the gate can still fire for one render');
});
test('CONTINUITY-SINGLE-EARLY-RETURN',()=>{
  const panels=guard.match(/return <StatePanel/g)||[];
  assert.ok(guard.indexOf('hasLoadedOnceRef.current && shifts.length === 0')<guard.indexOf('return <StatePanel'),'the only full-screen return must sit behind the first-load guard');
  assert.equal(panels.length,1,'a second full-screen early return would reintroduce the remount');
});
test('CONTINUITY-PICKER-RETURN-KEEPS-SECTION',()=>{
  assert.equal((panel.match(/setStep\(/g)||[]).length,1,'step may only change through navigateToStep');
  const nav=panel.split('const navigateToStep')[1].split('};')[0];
  assert.match(nav,/setStep\(next\)/);
  const choose=panel.split('const choose = async ()')[1].split('const upload = async ()')[0];
  assert.doesNotMatch(choose,/setStep|navigateToStep/,'choosing a document must never move the Guard off the section');
});
test('CONTINUITY-UPLOAD-REFRESHES-IMMEDIATELY',()=>{
  const fn=panel.split('const uploadAct = async')[1].split('};')[0];
  assert.ok(fn.indexOf('await fn()')<fn.indexOf('await load()'),'refresh must follow the upload');
  assert.match(fn,/await load\(\)/,'state must come back from getMyScreening(), not be assumed');
  const load=panel.split('const load = React.useCallback')[1].split('React.useEffect')[0];
  assert.match(load,/getMyScreening\(\)/);
});
test('CONTINUITY-BACKGROUND-KEEPS-STEP',()=>{
  const h=guard.split('function handleAppStateChange')[1].split('\n    }')[0];
  assert.match(h,/loadData\(\)/,'foreground still refreshes');
  assert.doesNotMatch(h,/setActiveTab|setStep/,'a foreground refresh must not renavigate');
});
test('CONTINUITY-BACKGROUND-KEEPS-UNSAVED-FORMS',()=>{
  const load=panel.split('const load = React.useCallback')[1].split('React.useEffect')[0];
  assert.doesNotMatch(load,/setAddress|setHistory|setStep/,'a refresh must not overwrite what the Guard is typing');
  for(const setter of ['setAddress(emptyAddressForm())','setHistory(emptyActivityForm())'])
    assert.ok(panel.includes(setter),'forms are still cleared explicitly on save/cancel');
});
test('CONTINUITY-PERSISTED-STATE-RELOADS-ON-REMOUNT',()=>{
  const eff=panel.split('React.useEffect(() => {')[1].split('}',2).join('}');
  assert.match(panel,/React\.useEffect\(\(\) => \{[\s\S]{0,80}load\(\)/,'a fresh mount must reload from the backend');
  assert.doesNotMatch(panel,/AsyncStorage|SecureStore|localStorage/,'no invented persistence for unsaved sensitive form data');
});


// ── Round 3: completed-state summaries, ongoing activity, admin reviewer workspace ────────────
const admin2=read('src/screens/AdminDashboardScreen.tsx');
const summaryFor=(step)=>panel.split('{step === "'+step+'" ?')[1].split('<SectionSummary')[1];

test('GUARD-SECTION-SUMMARY-COMPONENT',()=>{
  const comp=panel.split('function SectionSummary(')[1].split('function SectionState(')[0];
  // The contract: when satisfied and not editing, the form is NOT rendered at all.
  assert.match(comp,/if \(!settled \|\| editing\) return <>\{children\}<\/>;/,'the form must be replaced, not decorated');
  assert.match(comp,/status === "COMPLETE" \|\| status === "VERIFIED" \|\| status === "AWAITING_VERIFICATION"/);
  assert.doesNotMatch(panel,/localCompleted|completedSteps|setCompleted/,'no second completion model');
});
test('GUARD-EDIT-DISCLOSURE',()=>{
  for(const st of ['editingPersonal','replacingIdentity','editingAddresses','editingActivity','editingReferences','editingChecks'])
    assert.ok(panel.includes(st),'missing disclosure state '+st);
  assert.match(panel,/editing=\{editingPersonal\}/);
  assert.match(panel,/onEdit=\{\(\) => setEditingPersonal\(true\)\}/);
});
test('GUARD-PERSONAL-COMPLETE-SUMMARY',()=>{const b=summaryFor('personal');assert.match(b,/title="Personal details"/);for(const f of ['Name','Date of birth','Nationality','SIA licence type'])assert.ok(b.includes(f),'missing '+f);assert.match(b,/editLabel="Edit details"/)});
test('GUARD-IDENTITY-AWAITING-SUMMARY',()=>{const b=summaryFor('identity');assert.match(b,/title="Identity evidence"/);assert.match(b,/evidenceSummaryRows\("identity"\)/);assert.match(b,/editLabel="Replace document"/)});
test('GUARD-ADDRESS-COMPLETE-SUMMARY',()=>{const b=summaryFor('addresses');assert.match(b,/title="Address history"/);assert.match(b,/Current address/);assert.match(b,/Previous address/);assert.match(b,/editLabel="Edit history"/);assert.match(b,/Address evidence/,'evidence must sit with the chronology it proves')});
test('GUARD-ACTIVITY-COMPLETE-SUMMARY',()=>{const b=summaryFor('history');assert.match(b,/title="Activity history"/);assert.match(b,/historyTypeLabel\(h\.type\)/);assert.match(b,/h\.isCurrent \? "Present"/)});
test('GUARD-REFERENCE-COMPLETE-SUMMARY',()=>{const b=summaryFor('references');assert.match(b,/title="References"/);assert.match(b,/Covers:/);assert.match(b,/does not have to cover every activity period/,'must not imply one reference per period')});
test('GUARD-SIA-AWAITING-SUMMARY',()=>{const b=summaryFor('checks');assert.match(b,/SIA licence/);assert.match(b,/SIA expiry/);assert.match(b,/SIA check/)});
test('GUARD-RTW-AWAITING-SUMMARY',()=>{const b=summaryFor('checks');assert.match(b,/Right to Work"/);assert.match(b,/Right to Work check/);assert.doesNotMatch(b,/share.?code/i,'no invented share-code requirement')});
test('GUARD-OPTIONAL-EVIDENCE',()=>{const ev=panel.split('{step === "evidence" ?')[1].split('{step === "consent" ?')[0];assert.match(ev,/Optional supporting evidence/);assert.match(ev,/No additional evidence has been requested/)});
test('GUARD-DECLARATION-COMPLETE',()=>{const c=panel.split('{step === "consent" ?')[1].split('{step === "review" ?')[0];const accepted=c.split('if (current)')[1].split('return (')[1];assert.doesNotMatch(accepted,/Accept consent & declaration/);assert.match(accepted,/Withdraw consent/)});

test('GUARD-ONGOING-ACTIVITY',()=>{
  assert.match(panel,/I am still doing this/,'activity needs an explicit ongoing control');
  assert.match(panel,/isCurrent: history\.isCurrent,/,'the flag must be stored, not inferred from a blank end date');
  assert.doesNotMatch(panel,/isCurrent: !history\.endDate/,'the old inference must be gone');
  assert.match(panel,/endDate: history\.isCurrent \? undefined : screeningDateToIso\(history\.endDate\)/);
  assert.doesNotMatch(panel,/9999-/,'no fabricated future dates');
});
test('GUARD-ONGOING-SURVIVES-NEXT-DAY',()=>{
  // The real defect: an entry ending "today" reopens a one-day gap tomorrow. isCurrent clips to
  // today on every evaluation, so an ongoing record can never go stale.
  const svc=read('../security-backend-nest/src/screening/screening.service.ts');
  assert.match(svc,/const to = entry\.isCurrent \? end :/,'isCurrent must always clip to today');
  const body=svc.split('export function assessContinuousHistory')[1];
  const end=body.indexOf('\n}');
  // The extracted source is TypeScript, so transpile it before evaluating the real function.
  const js=toJs('function assessContinuousHistory'+body.slice(0,end)+'\n}');
  const run=new Function('BadRequestException',js+'; return assessContinuousHistory;')(class extends Error{});
  const today=new Date('2026-09-23T00:00:00Z');
  const ongoing=run([{startDate:'2015-01-01',endDate:null,isCurrent:true}],5,today);
  assert.equal(ongoing.continuous,true,'an ongoing activity must stay continuous as days pass');
  const stale=run([{startDate:'2015-01-01',endDate:'2026-09-22',isCurrent:false}],5,today);
  assert.equal(stale.continuous,false,'the original fixed-end entry is genuinely short by one day');
  assert.deepEqual(stale.gaps,[{from:'2026-09-23',to:'2026-09-23'}],'reproduces the reported one-day gap exactly');
});
test('GUARD-NONEMPLOYMENT-ACTIVITY',()=>{
  for(const [value,label] of [['EMPLOYMENT','Employed'],['SELF_EMPLOYMENT','Self-employed'],['UNEMPLOYMENT','Unemployed / looking for work'],['EDUCATION','Education / training'],['CAREER_BREAK','Career break / caring responsibilities'],['OVERSEAS','Overseas'],['OTHER_EXPLAINED_PERIOD','Other explained period']]){
    assert.ok(panel.includes('["'+value+'", "'+label+'"]'),'missing candidate label for '+value);
  }
  const ents=read('../security-backend-nest/src/screening/entities/screening.entities.ts');
  assert.match(ents,/enum HistoryType \{ EMPLOYMENT='EMPLOYMENT'/,'backend enum must be unchanged');
});
test('GUARD-ACTIVITY-LABEL-EVERYWHERE',()=>{
  // The summary is not the only place a Guard reads an activity type: the edit timeline and the
  // reference "which period does this cover" picker are candidate-facing too. Prettifying the raw
  // enum there leaks "Employment" next to the summary's "Employed".
  assert.doesNotMatch(panel,/pretty\(h\.type\)/,'every candidate-facing activity type goes through historyTypeLabel');
  assert.equal((panel.match(/historyTypeLabel\(/g)||[]).length,4,'summary + edit timeline + reference picker + reference summary');
});

test('ADMIN-REVIEW-SUMMARY',()=>{assert.match(admin2,/verificationSummary\?\.checks\.map/,'the ledger must come from the backend summary');assert.match(admin2,/checks complete/)});
test('ADMIN-PLAIN-BLOCKERS',()=>{assert.match(admin2,/blocker\.detail/,'blockers must render the sentence');assert.doesNotMatch(admin2,/\{blocker\.key\}</,'raw internal keys must never be displayed')});
test('ADMIN-EVIDENCE-FILENAME',()=>{assert.match(admin2,/entry\.originalFileName/);assert.match(admin2,/Uploaded \{date\(entry\.uploadedAt\)\}/)});
test('ADMIN-EVIDENCE-VIEW',()=>assert.match(admin2,/View document/));
test('ADMIN-EVIDENCE-VERIFY',()=>assert.match(admin2,/verifyScreeningCheck\(Number\(selected\.id\),reviewCategory,inspectedEvidenceId\)/));
test('ADMIN-EVIDENCE-REJECT',()=>{
  assert.match(admin2,/verifyScreeningCheck\(Number\(selected\.id\),reviewCategory,inspectedEvidenceId,'REJECTED'\)/,'reviewer must be able to reject');
  assert.match(admin2,/Reject evidence/);
  const api2=read('src/services/api.ts');
  assert.match(api2,/state:'VERIFIED'\|'REJECTED'='VERIFIED'/,'state must be a parameter, not hardcoded');
});
test('ADMIN-REJECT-RETURNS-ACTION-REQUIRED',()=>{
  // Rejecting required evidence must put the requirement back to ACTION_REQUIRED for the Guard.
  const svc=read('../security-backend-nest/src/screening/screening.service.ts');
  assert.match(svc,/!records\.length\|\|rejected\?'ACTION_REQUIRED'/,'a rejected latest record must reopen the requirement');
  assert.match(svc,/rejected=!verified&&latest\?\.verificationState===VerificationState\.REJECTED/);
  assert.match(admin2,/must supply replacement evidence/,'the reviewer message must say replacement is needed');
});
test('ADMIN-COMPLETE-GATED',()=>{
  assert.match(admin2,/disabled=\{!!reviewAction\|\|!reviewReadiness\?\.ready\}/,'Complete must be disabled until the backend says ready');
  const svc=read('../security-backend-nest/src/screening/screening.service.ts');
  assert.match(svc,/if\(!readiness\.ready\)throw new BadRequestException/,'the backend must remain the gate');
});
test('ADMIN-COMPLETE-VETTED',()=>{
  const svc=read('../security-backend-nest/src/screening/screening.service.ts');
  assert.match(svc,/s\.status=ScreeningStatus\.VETTED;/);
  assert.match(admin2,/Complete screening/);
});
test('ADMIN-EVIDENCE-METADATA-REVIEWER-ONLY',()=>{
  const svc=read('../security-backend-nest/src/screening/screening.service.ts');
  const proj=svc.split('const safeEvidence=')[1].split(';')[0];
  assert.match(proj,/\.\.\.\(reviewer\?\{originalFileName/,'filename is reviewer-only');
  assert.doesNotMatch(proj,/storageKey|signedUrl/,'never expose storage keys or signed URLs');
});


// ── High-volume reviewer queue ────────────────────────────────────────────────────────────────
const svc2=read('../security-backend-nest/src/screening/screening.service.ts');
const ctl2=read('../security-backend-nest/src/screening/screening.controller.ts');

test('QUEUE-DEFAULT-NEEDS-REVIEW',()=>{
  assert.match(admin2,/useState<ScreeningQueueFilter>\('needs_review'\)/,'the reviewer lands on work they can progress');
  // needs_review is a composite of the three progressable buckets, decided on the server.
  assert.match(svc2,/const NEEDS_REVIEW=\['AWAITING_REVIEW','UNDER_REVIEW','READY_TO_COMPLETE'\]/);
  assert.match(svc2,/const filter=query\.filter\?\?'needs_review'/);
});
test('QUEUE-COMPACT-ROWS',()=>{
  const row=admin2.split('queue?.rows.length?')[1].split('</View>:null}')[0];
  assert.match(row,/row\.guardName/);assert.match(row,/row\.guardEmail/);assert.match(row,/Submitted \{shortDate\(row\.submittedAt\)\}/);
  assert.match(row,/Candidate \{row\.progress\}% · Verification \{row\.verificationCompleted\}\/\{row\.verificationTotal\}/);
  assert.match(row,/QUEUE_BUCKET_LABEL\[row\.bucket\]/);
  for(const heavy of ['evidence','addresses','history','requirements','reviewReadiness'])
    assert.ok(!row.includes(`row.${heavy}`),`a queue row must not render ${heavy}`);
});
test('QUEUE-NO-DETAIL-PANEL',()=>{
  // The queue and the focused review are mutually exclusive: opening a Guard hides the queue.
  assert.match(admin2,/section === 'screening' && !selected \? <>/,'queue renders only when nothing is open');
  assert.match(admin2,/section !== 'overview' && section !== 'screening' && !loading && !error \? <View style=\{styles\.list\}>/,'the generic full-row list must not run for screening');
  assert.doesNotMatch(admin2,/loaders\[section\]\(\)[\s\S]{0,80}screening/,'screening must not go through the generic loader');
});
test('QUEUE-FILTERS',()=>{
  for(const key of ['needs_review','awaiting_review','under_review','needs_guard_action','ready_to_complete','vetted','not_submitted','all'])
    assert.ok(admin2.includes(`'${key}'`),'missing queue filter '+key);
  assert.match(admin2,/onPress=\{\(\)=>\{setQueueFilter\(option\.key\);setSelected\(null\);\}\}/);
  assert.match(ctl2,/@Get\('queue'\)[\s\S]{0,120}@Query\(\) q:ScreeningQueueQueryDto/,'queue is a validated admin endpoint');
});
test('QUEUE-SEARCH',()=>{
  assert.match(admin2,/placeholder=\{section === 'screening' \? 'Search Guards…'/);
  assert.match(admin2,/setTimeout\(\(\)=>setQueueTerm\(query\.trim\(\)\),300\)/,'search is debounced');
  assert.match(svc2,/`\$\{row\.guardName\?\?''\} \$\{row\.guardEmail\?\?''\}`\.toLowerCase\(\)\.includes\(term\)/,'search covers name and email server-side');
});
test('QUEUE-START-REVIEW',()=>assert.equal(admin2.match(/AWAITING_REVIEW: 'Start review'/)?.length,1));
test('QUEUE-CONTINUE',()=>assert.match(admin2,/UNDER_REVIEW: 'Continue review'/));
test('QUEUE-GUARD-ACTION',()=>assert.match(admin2,/NEEDS_GUARD_ACTION: 'View'/,'a Guard-blocked row offers no reviewer verification from the queue'));
test('QUEUE-READY-COMPLETE',()=>assert.match(admin2,/READY_TO_COMPLETE: 'Complete review'/));

// The separate YOUR ACTIONS / WAITING FOR GUARD sections became one six-row checklist that states
// ownership per check. The intent each test protected is preserved against the final layout.
test('DETAIL-YOUR-ACTIONS-FIRST',()=>{
  const body=admin2.split("<Text style={styles.detailHeading}>REVIEW CHECKLIST</Text>")[1];
  assert.ok(body,'the checklist must be the first thing under the summary');
  assert.ok(body.indexOf('View full application')>-1,'and the application dump comes after it');
  // Only checks whose candidate input has arrived are the reviewer's to action. That rule lives in
  // the service so the queue row and this view cannot disagree.
  assert.match(svc2,/const owner:'reviewer'\|'guard'\|'none'=c\.complete\?'none':gate\?\.status==='AWAITING_VERIFICATION'\?'reviewer':'guard'/);
});
test('DETAIL-WAITING-FOR-GUARD',()=>{
  assert.match(svc2,/const guardActions=req\.remediation\.filter\(x=>x\.status==='ACTION_REQUIRED'\)/);
  // A Guard-owned row says so and offers no reviewer control at all.
  assert.match(admin2,/entry\.owner==='guard'\?`Waiting for Guard — \$\{entry\.message\}`/);
  assert.match(admin2,/\{!entry\.complete&&entry\.owner==='reviewer'\?<Pressable/,'Review is offered only for reviewer-owned checks');
  assert.match(admin2,/Request information/);
});
test('DETAIL-COMPLETED-COLLAPSED',()=>{
  assert.match(admin2,/const \[completedOpen,setCompletedOpen\]=useState\(false\)/,'the application starts collapsed');
  assert.match(admin2,/View full application \(\{completedChecks\.length\}/);
  assert.match(admin2,/\{completedOpen&&!focusedReview\?<>[\s\S]{0,400}<View style=\{styles\.screeningReviewGrid\}>/,'the bulky application content sits behind the collapse');
});
test('DETAIL-BACK-TO-QUEUE',()=>{
  assert.match(admin2,/← Back to Screening Review/);
  assert.match(admin2,/const backToQueue=useCallback\(\(\)=>\{setSelected\(null\)/);
});
test('POST-ACTION-NO-FULL-LIST-REFETCH',()=>{
  // The regression that made review unusable at scale: every action re-downloaded every
  // application. refreshSelectedScreening must touch the open Guard and the compact queue only.
  const refresh=admin2.split('const refreshSelectedScreening=')[1].split('\n')[0];
  assert.doesNotMatch(refresh,/listScreenings/,'a review action must never re-download every screening');
  assert.match(refresh,/getScreening\(id\)/);
  assert.match(refresh,/loadQueue\(\)/);
  assert.equal(admin2.match(/listScreenings\(\)/g),null,'listScreenings is no longer called anywhere in the admin screen');
});
test('POST-VETTED-RETURN-QUEUE',()=>{
  const done=admin2.split('if(success){')[1].split('};')[0];
  assert.match(done,/setSelected\(null\)/,'completing returns the reviewer to the queue');
  assert.match(done,/loadQueue\(\)/,'the queue refreshes so the row leaves Needs review');
});
test('NO-BULK-VETTING',()=>{
  for(const banned of [/Verify all/i,/Approve all/i,/bulk/i,/mark multiple/i,/select all/i])
    assert.doesNotMatch(admin2,banned,'every Guard must remain individually reviewed');
  assert.doesNotMatch(svc2,/verifyMany|completeMany|bulk/i);
});
test('QUEUE-NO-FULL-APPLICATION-CLIENT',()=>{
  // The queue endpoint itself must stay compact; the client cannot be the only guard of that.
  const rowProjection=svc2.split('private queueRow(')[1].split('async queue(')[0];
  for(const heavy of ['safeEvidence','addresses:','history:','requirements:','reviewNotes'])
    assert.ok(!rowProjection.includes(heavy),`queue row must not carry ${heavy}`);
  assert.match(rowProjection,/guardName:s\.guard\?\.fullName/);
  assert.match(rowProjection,/guardEmail:s\.guard\?\.user\?\.email/);
});
test('QUEUE-ROW-SEPARATES-OWNERSHIP',()=>{
  // "5 actions outstanding" read as though the Guard was holding the file up when all five were
  // the reviewer's. The two sides are now named separately.
  assert.match(admin2,/Reviewer actions: \{row\.reviewerActions\} · Guard actions: \{row\.guardActions\}/);
  assert.doesNotMatch(admin2,/actions? outstanding/,'the ambiguous combined count must be gone');
});
test('DETAIL-SHARED-CLASSIFICATION',()=>{
  // One authoritative source: the opened review reads exactly what the queue row was built from.
  assert.match(admin2,/const classification=selected\?\.raw\?\.reviewClassification/);
  assert.match(admin2,/const yourActions=classification\?\.reviewerActions\|\|\[\]/);
  assert.match(admin2,/const waitingForGuard=classification\?\.guardActions\|\|\[\]/);
  assert.doesNotMatch(admin2,/REVIEWER_GATE/,'the client must not re-derive ownership');
  assert.match(svc2,/reviewClassification:reviewer\?/,'the detail projection carries the classification');
  assert.match(svc2,/private queueRow\(s:GuardScreening\)\{\s*const c=this\.classify\(s\);/,'the queue row is built from it too');
});
test('QUEUE-BUCKET-FROM-ACTIONABLE-STATE',()=>{
  const c=svc2.split('private classify(')[1].split('private queueRow(')[0];
  assert.doesNotMatch(c,/if\(s\.status===ScreeningStatus\.REQUIRES_ATTENTION\)return 'NEEDS_GUARD_ACTION'/,'a historical status flag must not decide ownership');
  assert.match(c,/if\(guardActions\.length\)return 'NEEDS_GUARD_ACTION'/,'ownership follows outstanding Guard work');
  assert.match(c,/if\(readiness\.ready&&s\.status===ScreeningStatus\.UNDER_REVIEW\)return 'READY_TO_COMPLETE'/,'never advertise completion from a status it cannot be reached from');
  assert.match(c,/informationRequestOutstanding:s\.status===ScreeningStatus\.REQUIRES_ATTENTION/,'the unanswered request is surfaced, not silently dropped');
});
test('DETAIL-TOP-SUMMARY-NO-DUPLICATION',()=>{
  const head=admin2.split('SCREENING REVIEW</Text>')[1].split('<Text style={styles.detailHeading}>REVIEW CHECKLIST</Text>')[0];
  assert.match(head,/Candidate application: /);
  assert.match(head,/check\$\{checksRemaining===1\?'':'s'\} remaining/);
  assert.match(head,/Reviewer actions remaining: \{yourActions\.length\}/);
  assert.match(head,/Guard actions remaining: \{waitingForGuard\.length\}/);
  assert.doesNotMatch(head,/requires review/,'the per-check breakdown belongs to the checklist alone');
  assert.doesNotMatch(head,/verificationSummary\?\.checks\.map/,'no second per-check list above the checklist');
  // ...and no third copy of the per-check buttons in the footer action grid.
  assert.doesNotMatch(admin2,/Review \{check==='rtw'\?'RTW':check\.toUpperCase\(\)\}/);
});
test('DETAIL-FOCUSED-REVIEW',()=>{
  assert.match(admin2,/const focusedReview=!!reviewCategory\|\|referencesOpen/);
  assert.match(admin2,/\{!focusedReview\?<><Text style=\{styles\.detailHeading\}>REVIEW CHECKLIST<\/Text>/,'choosing an action hides the checklist');
  assert.match(admin2,/\{completedOpen&&!focusedReview\?/,'the full application stays out of the way during a focused review');
});
test('REVIEW-CHECKLIST-SIX',()=>{
  // Six named checks from the backend, one next action each — not a remediation dump.
  assert.match(admin2,/<Text style=\{styles\.detailHeading\}>REVIEW CHECKLIST<\/Text>/);
  assert.match(admin2,/const checklist=classification\?\.checklist\|\|\[\]/,'the checklist comes from the shared classification');
  assert.match(svc2,/const CHECK_LABEL:Record<string,string>=\{identity:'Identity',address:'Address',sia:'SIA',rtw:'Right to Work',reference:'Reference',consent:'Declaration'\}/);
  assert.doesNotMatch(admin2,/REVIEWER_GATE/,'the screen must not re-derive ownership');
  assert.match(admin2,/\{checksRemaining===0\?'No checks remaining':`\$\{checksRemaining\} check\$\{checksRemaining===1\?'':'s'\} remaining`\}/);
});
test('REVIEW-NO-FULL-APPLICATION-DEFAULT',()=>{
  assert.match(admin2,/const \[completedOpen,setCompletedOpen\]=useState\(false\)/,'the application starts collapsed');
  // Everything bulky sits behind the disclosure, not under the checklist.
  const checklistBlock=admin2.split('REVIEW CHECKLIST</Text>')[1].split('collapseToggle')[0];
  for(const heavy of ['Activity chronology','Addresses</Text>','screeningReviewGrid','requirements?.missing'])
    assert.ok(!checklistBlock.includes(heavy),`the checklist must not render ${heavy}`);
});
test('REVIEW-VIEW-FULL-APPLICATION',()=>{
  assert.match(admin2,/View full application \(\{completedChecks\.length\} of \{checklist\.length\} checks complete\)/);
  const full=admin2.split('completedOpen&&!focusedReview?')[1];
  for(const kept of ['Activity chronology','Addresses','References & evidence','verificationSummary?.checks.map'])
    assert.ok(full.includes(kept),`audit detail must remain available: ${kept}`);
});
for(const [id,category,needle] of [
  ['REVIEW-FOCUSED-IDENTITY','identity','Submitted identity details'],
  ['REVIEW-FOCUSED-ADDRESS','address','Address being verified'],
  ['REVIEW-FOCUSED-SIA','sia','Submitted SIA information'],
  ['REVIEW-FOCUSED-RTW','rtw','Submitted Right to Work information'],
]){
  test(id,()=>{
    assert.match(admin2,new RegExp(`reviewCategory==='${category}'\\?<View style=\\{styles\\.submittedDetails\\}>`),'the focused task shows its own candidate data');
    assert.ok(admin2.includes(needle));
    // Opening a task hides the checklist rather than adding another panel below it.
    assert.match(admin2,/\{!focusedReview\?<><Text style=\{styles\.detailHeading\}>REVIEW CHECKLIST<\/Text>/);
  });
}
test('REVIEW-FOCUSED-REFERENCE',()=>{
  const panel=admin2.split('Controlled reference decision')[1].split('Record reference decision')[0];
  assert.match(panel,/Candidate claims: /,'the claim the reference is being checked against');
  assert.match(panel,/Reference confirmed<\/Text>/,'and what the referee actually confirmed');
  assert.match(panel,/Confirmed start date/);assert.match(panel,/Still current/);assert.match(panel,/Confirmed end date/);
  for(const outcome of ["'Confirmed'","'Discrepancy'","'Unable to verify'","'Reject'","'Request clarification'"])
    assert.ok(panel.includes(outcome),'missing reference outcome '+outcome);
  for(const status of ['VERIFIED','DISCREPANCY','SOURCE_VERIFICATION_REQUIRED','UNABLE_TO_VERIFY','REJECTED'])
    assert.ok(panel.includes(`'${status}'`),'missing reference status '+status);
  assert.match(panel,/Reference verification method/);
});
test('REVIEW-CONSENT-READONLY',()=>{
  // The declaration is a candidate act: it shows state and offers the reviewer no action.
  assert.match(admin2,/if\(key==='consent'\)return;/,'consent opens no reviewer task');
  assert.match(admin2,/entry\.complete\?`✓ \$\{entry\.message\}`/,'a satisfied check reads as done');
});
test('REVIEW-DISCREPANCY-SURFACED',()=>{
  // The panel contains a nested ternary, so slice a window rather than splitting on ':null}'.
  const block=admin2.split('Reference discrepancy')[1].slice(0,1200);
  assert.match(block,/Candidate claimed: /);
  assert.match(block,/Reference confirmed: /);
  assert.match(block,/cannot be completed until the discrepancy is resolved/);
  assert.match(admin2,/classification\?\.referenceDiscrepancy/);
});
test('REVIEW-CONFIRMED-DATES-SENT',()=>{
  assert.match(admin2,/confirmedStartDate:confirmedStart\.trim\(\)/);
  assert.match(admin2,/confirmedCurrent\?\{confirmedIsCurrent:true\}:\{confirmedEndDate:confirmedEnd\.trim\(\)\}/);
  assert.match(admin2,/Record the start date the reference confirmed\./,'the client refuses to send an incomplete confirmation');
  const api2=read('src/services/api.ts');
  assert.match(api2,/'VERIFIED'\|'DISCREPANCY'\|'UNABLE_TO_VERIFY'\|'REJECTED'\|'SOURCE_VERIFICATION_REQUIRED'/);
});
test('QUEUE-NO-NPLUS1-SOURCE',()=>{
  const loader=svc2.split('private async loadQueueAggregate()')[1].split('private queueRow(')[0];
  assert.match(loader,/loadRelationIds/,'children load by set, not per screening');
  assert.match(loader,/In\(ids\)/);
  assert.doesNotMatch(loader,/this\.full\(/,'the queue must never materialise a full application');
  assert.doesNotMatch(loader,/map\(async/,'no per-screening await fan-out');
});

console.log(JSON.stringify({event:'screening_ux_tests_passed',tests:passed}));
