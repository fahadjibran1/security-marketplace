const assert=require('assert'),fs=require('fs'),path=require('path');let passed=0;
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const panel=read('src/components/guard/GuardScreeningPanel.tsx'),service=read('../security-backend-nest/src/screening/screening.service.ts'),dto=read('../security-backend-nest/src/screening/dto/screening.dto.ts'),entity=read('../security-backend-nest/src/screening/entities/screening.entities.ts');
function test(name,fn){fn();passed++;console.log(`PASS ${name}`);}

const refBlock=()=>panel.split('step === "references"')[1].split('step === "checks"')[0];

// REFERENCE — No history state
test('no history shows prerequisite warning not empty form',()=>{assert.match(panel,/Add your activity history before adding a referee/);});
test('no history shows navigation to Activity History step',()=>{assert.match(panel,/Go to Activity History/);assert.match(panel,/navigateToStep\("history"\)/);});
test('no history branch renders a warning View block',()=>{assert.match(panel,/!data\.history\?\.length[\s\S]{0,200}s\.warning/);});
test('activity history check precedes the referee form selector',()=>{
  const rb=refBlock();
  assert.ok(rb.indexOf('!data.history?.length')>=0,'must have !data.history?.length check in references block');
  assert.ok(rb.indexOf('!data.history?.length')<rb.indexOf('Which activity period can this referee confirm'),'history check must precede selector');
});

// REFERENCE — Required field labels
test('activity period selector label includes required marker',()=>{assert.match(panel,/Which activity period can this referee confirm\? \*/);});
test('organisation field label includes required marker',()=>{assert.match(panel,/label="Organisation \*"/);});
test('referee name field label includes required marker',()=>{assert.match(panel,/label="Referee name \*"/);});
test('relationship field label includes required marker',()=>{assert.match(panel,/label="Relationship \*"/);});
test('business email field label includes required marker',()=>{assert.match(panel,/label="Business email \*"/);});
test('phone field remains optional — no required marker',()=>{assert.match(panel,/Phone \(optional\)/);assert.doesNotMatch(panel,/label="Phone \*"/);});
test('required field footnote is displayed',()=>{assert.match(panel,/\* Required field/);});

// REFERENCE — Client-side validation before API call
test('validation checks historyId before addMyScreeningReference',()=>{
  const rb=refBlock();
  assert.ok(rb.indexOf('Select the activity period')>=0&&rb.indexOf('Select the activity period')<rb.indexOf('addMyScreeningReference'),'historyId validation must precede API call');
});
test('validation checks organisation before addMyScreeningReference',()=>{
  const rb=refBlock();
  assert.ok(rb.indexOf('Organisation is required')>=0&&rb.indexOf('Organisation is required')<rb.indexOf('addMyScreeningReference'),'org validation must precede API call');
});
test('validation checks contactPerson before addMyScreeningReference',()=>{
  const rb=refBlock();
  assert.ok(rb.indexOf('Referee name is required')>=0&&rb.indexOf('Referee name is required')<rb.indexOf('addMyScreeningReference'),'contactPerson validation must precede API call');
});
test('validation checks relationship before addMyScreeningReference',()=>{
  const rb=refBlock();
  assert.ok(rb.indexOf('Relationship is required')>=0&&rb.indexOf('Relationship is required')<rb.indexOf('addMyScreeningReference'),'relationship validation must precede API call');
});
test('validation checks email format before addMyScreeningReference',()=>{
  const rb=refBlock();
  assert.ok(rb.indexOf('valid business email')>=0&&rb.indexOf('valid business email')<rb.indexOf('addMyScreeningReference'),'email validation must precede API call');
});
test('email validation uses a regex pattern not just presence check',()=>{
  assert.ok(panel.includes('[^\\s@]+@[^\\s@]+'),'email regex character class not found in source');
});
test('validation errors are stored in refErrors state',()=>{assert.match(panel,/setRefErrors\(errs\)/);assert.match(panel,/refErrors\.map/);});
test('validation errors render with alert accessibility role',()=>{
  const rb=refBlock();
  assert.ok(rb.indexOf('refErrors.length > 0')>=0,'refErrors.length guard must be in references block');
  assert.match(rb,/accessibilityRole="alert"[\s\S]{0,200}refErrors\.map/);
});

// REFERENCE — Trimming and clean submission payload
test('organisation is trimmed before submission',()=>{assert.match(panel,/organisation:\s*reference\.organisation\.trim\(\)/);});
test('contactPerson is trimmed before submission',()=>{assert.match(panel,/contactPerson:\s*reference\.contactPerson\.trim\(\)/);});
test('relationship is trimmed before submission',()=>{assert.match(panel,/relationship:\s*reference\.relationship\.trim\(\)/);});
test('businessEmail is trimmed before submission',()=>{assert.match(panel,/businessEmail:\s*reference\.businessEmail\.trim\(\)/);});
test('phone is trimmed and undefined when blank before submission',()=>{assert.match(panel,/phone:\s*reference\.phone\.trim\(\) \|\| undefined/);});

// REFERENCE — State reset after successful save
test('emptyReferenceForm factory is defined at module level',()=>{assert.match(panel,/const emptyReferenceForm = \(\)/);});
test('reference state is initialised with emptyReferenceForm',()=>{assert.match(panel,/useState\(emptyReferenceForm\(\)\)/);});
test('refErrors is cleared on navigateToStep',()=>{assert.match(panel,/const navigateToStep[\s\S]{0,200}setRefErrors\(\[\]\)/);});
test('reference form resets after successful save',()=>{
  const parts=panel.split('addMyScreeningReference');
  assert.ok(parts.length>=3,'expected at least 2 addMyScreeningReference occurrences');
  const afterCall=parts.slice(2).join('addMyScreeningReference').split('EvidencePicker')[0];
  assert.ok(afterCall.includes('setReference(emptyReferenceForm())'),'reference form must reset on success');
});
test('refErrors cleared after successful reference save',()=>{
  const parts=panel.split('addMyScreeningReference');
  const afterCall=parts.slice(2).join('addMyScreeningReference').split('EvidencePicker')[0];
  assert.ok(afterCall.includes('setRefErrors([])'),'refErrors must clear on success');
});

// REFERENCE — Safety: no auto-verify
test('new reference status defaults to NOT_REQUESTED in entity',()=>{assert.match(entity,/NOT_REQUESTED/);});
test('addReference service never writes VERIFIED status',()=>{
  const addBlock=service.split('addReference')[1].split('async ')[0];
  assert.doesNotMatch(addBlock,/VERIFIED|sourceVerified.*true|verifiedAt\s*=/);
});
test('backend AddReferenceDto has no status field',()=>{
  const dtoBlock=dto.split('AddReferenceDto')[1].split('CreateEvidenceDto')[0];
  assert.doesNotMatch(dtoBlock,/status|verified/i);
});

// REFERENCE — Non-editable state explanation (root cause of REFEREE SAVE STILL FAILING)
test('references step renders REFEREE DETAILS LOCKED when canEdit is false',()=>{
  const rb=refBlock();
  assert.match(rb,/REFEREE DETAILS LOCKED/);
});
test('locked explanation uses STATUS[data.status] for user-readable status name',()=>{
  const rb=refBlock();
  assert.match(rb,/STATUS\[data\.status\]/);
});
test('!canEdit gate in references block precedes referee form selector',()=>{
  const rb=refBlock();
  assert.ok(rb.indexOf('!canEdit')>=0,'!canEdit check must be in references block');
  assert.ok(rb.indexOf('!canEdit')<rb.indexOf('Which activity period can this referee confirm'),'!canEdit gate must precede selector');
});
test('Add referee button disabled by busy only — canEdit guaranteed true in that branch',()=>{
  const rb=refBlock();
  const beforeAddReferee=rb.split('Add referee')[0];
  const lastDisabledLine=beforeAddReferee.split('\n').slice(-5).join('\n');
  assert.match(lastDisabledLine,/disabled=\{busy\}/);
  assert.doesNotMatch(lastDisabledLine,/disabled=\{!canEdit/);
});

// REFERENCE — Independence from evidence upload
test('Add referee button does not depend on evidence upload state',()=>{
  const rb=refBlock();
  const beforeAddReferee=rb.split('Add referee')[0];
  const lastDisabledLine=beforeAddReferee.split('\n').slice(-8).join('\n');
  assert.doesNotMatch(lastDisabledLine,/uploadCompleted|canUploadEvidence/);
});
test('EvidencePicker for reference appears after Add referee in DOM order',()=>{
  const rb=refBlock();
  assert.ok(rb.indexOf('Add referee')>=0,'Add referee must exist');
  assert.ok(rb.indexOf('EvidencePicker')>rb.indexOf('Add referee'),'EvidencePicker must follow Add referee');
});

// DOCUMENT — uploadAct isolation from parent busy state (primary regression fix)
test('uploadAct does not touch parent busy state — upload cannot grey referee save button',()=>{
  const uploadActBody=panel.split('uploadAct = async')[1].split('const canEdit')[0];
  assert.doesNotMatch(uploadActBody,/setBusy\(/,'uploadAct must not call setBusy — EvidencePicker has its own uploading state');
});

// DOCUMENT — uploadAct and categorizeUploadError
test('uploadAct helper is defined inside component',()=>{assert.match(panel,/uploadAct = async/);});
test('categorizeUploadError is defined in the component',()=>{assert.match(panel,/categorizeUploadError = \(message: string\): string/);});
test('categorizeUploadError maps storage-unavailable to safe message',()=>{
  const fn=panel.split('categorizeUploadError = ')[1].split('uploadAct =')[0];
  assert.ok(fn.includes('not configured')&&fn.includes('temporarily unavailable'),'storage error must map to temporarily unavailable');
});
test('categorizeUploadError maps session error to safe message',()=>{
  const fn=panel.split('categorizeUploadError = ')[1].split('uploadAct =')[0];
  assert.ok(fn.includes('session has expired'),'session error must map to user-safe message');
});
test('categorizeUploadError maps network error to safe message',()=>{
  const fn=panel.split('categorizeUploadError = ')[1].split('uploadAct =')[0];
  assert.ok(fn.includes('upload service'),'network error must map to user-safe message');
});

// DOCUMENT — EvidencePicker error visibility
test('EvidencePicker onUpload type is string or null not boolean',()=>{
  assert.match(panel,/onUpload: \(asset: DocumentPicker\.DocumentPickerAsset\) => Promise<string \| null>/);
});
test('EvidencePicker clears asset on null result (success)',()=>{
  assert.match(panel,/uploadResult === null[\s\S]{0,50}setAsset\(null\)/);
});
test('EvidencePicker shows returned error string inline on failure',()=>{
  assert.match(panel,/uploadResult === null[\s\S]{0,200}setUploadError\(uploadResult\)/);
});
test('EvidencePicker renders upload error text adjacent to upload control',()=>{
  assert.match(panel,/uploadError\?<Text style=\{s\.error\}>\{uploadError\}/);
});
test('upload failure retains selected document (asset not cleared on error)',()=>{
  assert.doesNotMatch(panel,/else\s*\{[\s\S]{0,80}setAsset\(null\)/);
});
test('retry remains available — uploading state released in finally block',()=>{
  assert.match(panel,/setUploading\(true\)[\s\S]{0,400}finally[\s\S]{0,60}setUploading\(false\)/);
});

// DOCUMENT — No secrets in error messages
test('categorizeUploadError return values contain no storage credential patterns',()=>{
  const fn=panel.split('categorizeUploadError = ')[1].split('uploadAct =')[0];
  assert.doesNotMatch(fn,/EVIDENCE_STORAGE_SECRET|EVIDENCE_STORAGE_ACCESS|X-Amz-Signature|signedUrl/);
});
test('all EvidencePicker instances use uploadAct for upload operations',()=>{
  const pickers=panel.match(/onUpload=\{[\s\S]{0,100}(uploadAct|act)\(/g)||[];
  assert.ok(pickers.length>=5,'expected at least 5 EvidencePicker onUpload bindings');
  pickers.forEach(p=>{
    assert.ok(p.includes('uploadAct'),'found EvidencePicker not using uploadAct: '+p.slice(-40));
  });
});

// DOCUMENT — Upload validation unchanged
test('MIME type allow-list remains PDF JPEG PNG',()=>{
  for(const mime of ['application/pdf','image/jpeg','image/png'])
    assert.match(panel,new RegExp(mime.replace('/','\\/')));
});
test('10 MB size limit remains enforced before metadata creation',()=>{
  assert.ok(panel.indexOf('10 MB size limit')<panel.lastIndexOf('createMyScreeningEvidence'),'size check must precede createMyScreeningEvidence');
});
test('empty or size-unavailable file is still rejected before API call',()=>{assert.match(panel,/selected document is empty or its size is unavailable/);});
test('cancelled document picker remains safe',()=>{assert.match(panel,/if \(result\.canceled\) return/);});

// UPLOAD LOCAL FEEDBACK — Success feedback must be local to EvidencePicker, not global
test('uploadAct does not call setFeedback with a success message — upload success is local to picker',()=>{
  const uploadActBody=panel.split('uploadAct = async')[1].split('const canEdit')[0];
  assert.doesNotMatch(uploadActBody,/setFeedback\(message\)/,'uploadAct must not call setFeedback(message) — success feedback belongs inside EvidencePicker, not the global banner');
});
test('EvidencePicker has successMessage prop in its type signature',()=>{
  const pickerFn=panel.split('function EvidencePicker')[1].split('function PeriodGuidance')[0];
  assert.match(pickerFn,/successMessage\?:\s*string/,'EvidencePicker must declare successMessage optional string prop');
});
test('EvidencePicker owns uploadSuccess local state',()=>{
  const pickerFn=panel.split('function EvidencePicker')[1].split('function PeriodGuidance')[0];
  assert.match(pickerFn,/uploadSuccess[\s\S]{0,10}setUploadSuccess[\s\S]{0,10}=\s*React\.useState\(""\)/,'EvidencePicker must have uploadSuccess state initialised to empty string');
});
test('selecting a new document clears stale upload success',()=>{
  const pickerFn=panel.split('function EvidencePicker')[1].split('function PeriodGuidance')[0];
  const chooseBody=pickerFn.split('const choose')[1].split('const upload')[0];
  assert.match(chooseBody,/setUploadSuccess\(""\)/,'choose() must clear uploadSuccess so stale success does not persist after new document selection');
});
test('upload success is set locally inside EvidencePicker when onUpload returns null',()=>{
  const pickerFn=panel.split('function EvidencePicker')[1].split('function PeriodGuidance')[0];
  assert.match(pickerFn,/uploadResult === null[\s\S]{0,200}setUploadSuccess\(/,'upload() must call setUploadSuccess after checking uploadResult === null');
});
test('EvidencePicker renders upload success with pickerSuccess style adjacent to upload control',()=>{
  const pickerFn=panel.split('function EvidencePicker')[1].split('function PeriodGuidance')[0];
  assert.match(pickerFn,/uploadSuccess\?<Text accessibilityRole="alert" style=\{s\.pickerSuccess\}>\{uploadSuccess\}<\/Text>:null/,'EvidencePicker must render uploadSuccess inline with pickerSuccess style and alert role');
});
test('each EvidencePicker instance carries its own successMessage — no shared state',()=>{
  const successMessages=panel.match(/successMessage="[^"]+"/g)||[];
  assert.ok(successMessages.length>=6,'expected at least 6 distinct successMessage prop values — one per EvidencePicker instance');
  const unique=new Set(successMessages);
  assert.ok(unique.size>=3,'successMessage values must differ across pickers — shared message would indicate a copy-paste without category specificity');
});

console.log(JSON.stringify({event:'post_phys007_uat_remediation_tests_passed',tests:passed}));
