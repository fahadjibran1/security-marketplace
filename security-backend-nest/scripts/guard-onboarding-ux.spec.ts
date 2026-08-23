import { readFileSync } from 'fs';
import { resolve } from 'path';
import { assessContinuousHistory } from '../src/screening/screening.service';

type Test={name:string;run:()=>void};const tests:Test[]=[];const test=(name:string,run:()=>void)=>tests.push({name,run});
const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const backend=(file:string)=>readFileSync(resolve(__dirname,'../src',file),'utf8');
const frontend=(file:string)=>readFileSync(resolve(__dirname,'../../security-mobile-app/src',file),'utf8');
const controller=backend('screening/screening.controller.ts');
const service=backend('screening/screening.service.ts');
const panel=frontend('components/guard/GuardScreeningPanel.tsx');
const profile=frontend('components/guard/GuardCompliancePanel.tsx');
const api=frontend('services/api.ts');
const compliance=backend('compliance/compliance.service.ts');

test('Guard can edit an owned address',()=>assert(controller.includes("@Put('mine/addresses/:id')")&&service.includes('async updateAddress(userId:number,id:number'),'address update missing'));
test('Guard can delete an owned address where editable',()=>assert(controller.includes("@Delete('mine/addresses/:id')")&&service.includes('async deleteAddress(userId:number,id:number'),'address delete missing'));
test('Address mutation refreshes authoritative screening state',()=>assert(api.includes('updateMyScreeningAddress')&&panel.includes('authoritative coverage check has been refreshed'),'address refresh missing'));
test('Guard can edit activity history',()=>assert(controller.includes("@Put('mine/history/:id')")&&service.includes('async updateHistory(userId:number,id:number'),'history update missing'));
test('Guard can delete activity history where editable',()=>assert(controller.includes("@Delete('mine/history/:id')")&&service.includes('async deleteHistory(userId:number,id:number'),'history delete missing'));
test('Missing activity period remains server-derived',()=>{const result=assessContinuousHistory([],5,new Date('2026-08-24T12:00:00Z'));assert(result.gaps.length===1&&panel.includes('data.requirements?.chronology.gaps'),'authoritative gap missing');});
test('Missing SIA expiry has candidate remediation',()=>assert(service.includes("'Add your SIA licence expiry date.'")&&panel.includes('SIA licence expiry date (DD/MM/YYYY)'),'SIA remediation missing'));
test('Missing Right to Work has candidate remediation',()=>assert(service.includes("'Add your Right to Work status and expiry where applicable.'")&&panel.includes('Right to Work status / type'),'RTW remediation missing'));
test('Address evidence remediation identifies its address period',()=>assert(service.includes('Upload proof of address for')&&service.includes('currentAddress.startDate'),'address evidence is not contextual'));
test('Uploaded evidence is not represented as verified',()=>assert(panel.includes('Uploading evidence does not verify it.')&&profile.includes('Provided — awaiting verification'),'evidence status unsafe'));
test('Review and Submit uses exact server outstanding requirements',()=>assert(panel.includes('data.requirements?.remediation')&&panel.includes('item.message'),'structured review missing'));
test('Fix-this navigation reaches server-selected step',()=>assert(panel.includes('onFix(item.step)')&&panel.includes('navigateToStep(target as Step)'),'fix navigation missing'));
test('Recruitment approval remains fail closed with clearer company UX',()=>assert(compliance.includes('Guard compliance invalid')&&frontend('screens/CompanyDashboardScreen.tsx').includes('Guard onboarding incomplete'),'compliance bypass detected'));
test('Candidate cannot self-verify compliance',()=>assert(controller.includes("@Patch(':id/checks/:check') @Roles(UserRole.ADMIN)")&&!api.includes("state:'VETTED'"),'self verification exposed'));
test('Company cannot bypass screening requirements',()=>assert(compliance.includes('assertGuardAssignable')&&compliance.includes('screeningService.isGuardVetted'),'company bypass detected'));
test('Record ownership remains guard screening scoped',()=>assert(service.includes('record.screening.id!==screening.id')&&service.includes("throw new ForbiddenException('Address entry is not part of this screening file.')"),'ownership check missing'));
test('Candidate edits reset verification state',()=>assert((service.match(/verificationState:VerificationState.UNVERIFIED/g)||[]).length>=2,'verification not reset'));
test('Profile contains read-only summary and one compliance route',()=>assert(profile.includes('Compliance summary')&&profile.includes('Manage compliance')&&!profile.includes('updateMyGuard'),'duplicate profile editor remains'));
test('Private evidence details are not exposed by onboarding UI',()=>assert(!panel.includes('storageKey')&&!profile.includes('signedUrl'),'private evidence leaked'));

let passed=0;for(const entry of tests){entry.run();console.log(`PASS ${++passed}/${tests.length} ${entry.name}`);}console.log(`SEC-018E guard onboarding UX: ${passed}/${tests.length} PASS`);
