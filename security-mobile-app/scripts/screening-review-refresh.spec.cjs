const fs=require('fs');const path=require('path');
const read=(file)=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const screen=read('src/screens/AdminDashboardScreen.tsx');const api=read('src/services/api.ts');const controller=read('../security-backend-nest/src/screening/screening.controller.ts');
const tests=[];const test=(name,check)=>tests.push({name,check});const has=(source,value)=>source.includes(value);const assert=(value,message)=>{if(!value)throw new Error(message);};
test('Verify Identity refreshes authoritative selected state',()=>assert(has(screen,"runReviewAction(`verify-${reviewCategory}`")&&has(screen,"getScreening(id)"),'identity refresh path missing'));
// The four verifiable categories are now reached from YOUR ACTIONS, which lists only the checks
// that actually need one, instead of a permanently rendered row of four buttons.
test('Verify Address is represented in open detail',()=>assert(has(screen,"['Address',selected.raw?.addresses?.find")&&has(screen,"key as 'identity'|'address'|'sia'|'rtw'"),'address state missing'));
test('Verify SIA refreshes open screening',()=>assert(has(screen,"verifyScreeningCheck(Number(selected.id),reviewCategory,inspectedEvidenceId)")&&has(screen,"setSelected(detailRow)"),'SIA refresh missing'));
test('Verify RTW refreshes open screening',()=>assert(has(screen,"reviewCategory==='rtw'?'Right to Work'")&&has(screen,"setSelected(detailRow)"),'RTW refresh missing'));
test('successful verification keeps detail open',()=>assert(!has(screen,'await verifyScreeningCheck(Number(selected.id),check);await load();'),'legacy stale verification flow retained'));
test('pending action prevents duplicate requests',()=>assert(has(screen,'if(reviewAction||!selected)return')&&has(screen,'disabled={!!reviewAction}')&&has(screen,"'Verifying…'"),'pending guard missing'));
test('failed verification keeps detail open and formats error',()=>assert(has(screen,"formatApiErrorMessage(actionError")&&!has(screen,'catch(actionError){setSelected(null)'), 'failure handling unsafe'));
test('Start Review refreshes same guard to authoritative state',()=>assert(has(screen,"runReviewAction('start'")&&has(screen,'refreshSelectedScreening(selectedId)'),'start review refresh missing'));
test('Complete Screening refreshes final state',()=>assert(has(screen,"runReviewAction('complete'")&&has(screen,"'Screening completed successfully.'"),'complete refresh missing'));
test('Request Information refreshes state',()=>assert(has(screen,"runReviewAction('request'")&&has(screen,"'Information request recorded successfully.'"),'request refresh missing'));
test('Reject and Expire refresh state',()=>assert(has(screen,"runReviewAction('reject'")&&has(screen,"runReviewAction('expire'"),'terminal refresh missing'));
// The selected Guard is still replaced by authoritative server state after every action, but the
// reviewer queue made re-downloading every screening to do it untenable: refresh the open Guard,
// then the compact queue.
test('selected object is replaced with authoritative detail',()=>assert(has(screen,'const detail=await getScreening(id);const detailRow=displayRow(\'screening\',detail,0);setSelected(detailRow)')&&!has(screen,'listScreenings()'),'stale selected data retained'));
test('reviewer authority remains ADMIN-only',()=>assert(has(controller,"@Patch(':id/checks/:check') @Roles(UserRole.ADMIN)")&&!has(api,'state:\'VETTED\''),'reviewer boundary weakened'));
let passed=0;for(const entry of tests){entry.check();console.log(`PASS ${++passed}/${tests.length} ${entry.name}`);}console.log(`SEC-018G admin screening review refresh: ${passed}/${tests.length} PASS`);
