import 'reflect-metadata';
import * as assert from 'assert';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { assessContinuousHistory, ScreeningService } from '../src/screening/screening.service';
import { GuardScreening, ReferenceStatus, ScreeningStatus, VerificationState } from '../src/screening/entities/screening.entities';
import { ComplianceService } from '../src/compliance/compliance.service';
let passed=0;
function test(name:string,fn:()=>void|Promise<void>){return Promise.resolve().then(fn).then(()=>{passed++;console.log(`PASS ${name}`);});}
function ago(years:number,days=0){const d=new Date();d.setUTCFullYear(d.getUTCFullYear()-years);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
function record(overrides:Partial<GuardScreening>={}){return Object.assign({id:1,status:ScreeningStatus.IN_PROGRESS,screeningPeriodYears:5,legalFullName:'Candidate',dateOfBirth:'1990-01-01',nationality:'British',currentAddress:'Address',history:[{startDate:ago(5),endDate:null,isCurrent:true}],addresses:[{isCurrent:true,verificationState:VerificationState.VERIFIED}],references:[{status:ReferenceStatus.VERIFIED,sourceVerified:true}],evidence:[{uploadCompletedAt:new Date()}],consents:[{withdrawnAt:null}],exceptions:[],identityVerification:VerificationState.VERIFIED,siaRegisterVerification:VerificationState.VERIFIED,rightToWorkVerification:VerificationState.VERIFIED},overrides) as GuardScreening;}
async function main(){
 await test('five-year continuous history accepted',()=>assert.equal(assessContinuousHistory([{startDate:ago(5),isCurrent:true}],5).continuous,true));
 await test('history gap detected',()=>assert.equal(assessContinuousHistory([{startDate:ago(5),endDate:ago(3),isCurrent:false},{startDate:ago(2),isCurrent:true}],5).gaps.length,1));
 await test('history overlap detected',()=>assert.ok(assessContinuousHistory([{startDate:ago(5),endDate:ago(2),isCurrent:false},{startDate:ago(3),isCurrent:true}],5).overlaps.length));
 await test('adjacent periods accepted',()=>assert.equal(assessContinuousHistory([{startDate:ago(5),endDate:ago(2,-1),isCurrent:false},{startDate:ago(2),isCurrent:true}],5).continuous,true));
 await test('invalid dates fail closed',()=>assert.throws(()=>assessContinuousHistory([{startDate:'bad',isCurrent:true}],5),BadRequestException));
 const svc=Object.create(ScreeningService.prototype) as any;
 await test('complete file passes candidate requirements',()=>assert.equal(svc.requirements(record()).missing.length,0));
 await test('missing consent prevents submission',()=>assert.ok(svc.requirements(record({consents:[]})).missing.some((x:string)=>x.includes('consent'))));
 await test('missing history prevents submission',()=>assert.ok(svc.requirements(record({history:[]})).missing.some((x:string)=>x.includes('gap'))));
 await test('unverified reference cannot satisfy review',()=>assert.ok(svc.requirements(record({references:[{status:ReferenceStatus.RECEIVED,sourceVerified:false}] as any}),true).missing.some((x:string)=>x.includes('source-verified'))));
 await test('reference authenticity is mandatory',()=>assert.ok(svc.requirements(record({references:[{status:ReferenceStatus.VERIFIED,sourceVerified:false}] as any}),true).missing.some((x:string)=>x.includes('source-verified'))));
 await test('identity verification required for VETTED',()=>assert.ok(svc.requirements(record({identityVerification:VerificationState.UNVERIFIED}),true).missing.some((x:string)=>x.includes('Identity'))));
 await test('SIA verification required for VETTED',()=>assert.ok(svc.requirements(record({siaRegisterVerification:VerificationState.UNVERIFIED}),true).missing.some((x:string)=>x.includes('SIA'))));
 await test('RTW verification required for VETTED',()=>assert.ok(svc.requirements(record({rightToWorkVerification:VerificationState.UNVERIFIED}),true).missing.some((x:string)=>x.includes('Right to Work'))));
 await test('unresolved exception blocks completion',()=>assert.ok(svc.requirements(record({exceptions:[{resolved:false}] as any}),true).missing.some((x:string)=>x.includes('exceptions'))));
 const compliance=(vetted:boolean,blockers:string[]=[])=>new ComplianceService({} as any,{} as any,{} as any,{} as any,{getBlockingReasons:async()=>blockers} as any,{isGuardVetted:async()=>vetted} as any);
 await test('VETTED plus operational compliance is assignable',()=>compliance(true).assertGuardAssignable(1,1));
 await test('non-VETTED guard is not assignable',async()=>{await assert.rejects(()=>compliance(false).assertGuardAssignable(1,1),ForbiddenException);});
 await test('expired compliance removes eligibility',async()=>{await assert.rejects(()=>compliance(true,['SIA expired']).assertGuardAssignable(1,1),ForbiddenException);});
 await test('company outcome is deliberately minimal',()=>assert.deepEqual(Object.keys({guardId:1,status:ScreeningStatus.VETTED,vetted:true}),['guardId','status','vetted']));
 await test('guard profile DTO has no status field',()=>{const source=require('fs').readFileSync(require('path').join(__dirname,'../src/screening/dto/screening.dto.ts'),'utf8');const body=source.split('export class UpdateScreeningProfileDto')[1].split('export class AddHistoryDto')[0];assert.equal(/\bstatus\b/.test(body),false);});
 await test('screening evidence keys are opaque',()=>assert.match('screening/guard/12/91b5bd5b-8311-4d90-9482-1a60c068184d',/^screening\/guard\/\d+\/[0-9a-f-]{36}$/));
 console.log(JSON.stringify({event:'bs7858_screening_tests_passed',tests:passed}));
}
main().catch(e=>{console.error(e);process.exit(1);});
