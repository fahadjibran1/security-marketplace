import 'reflect-metadata';
import * as assert from 'assert';
import { ComplianceService } from '../src/compliance/compliance.service';
import { assessContinuousHistory } from '../src/screening/screening.service';
import { ScreeningStatus } from '../src/screening/entities/screening.entities';
import { UserStatus } from '../src/user/entities/user.entity';
let passed=0; async function test(name:string,fn:()=>unknown|Promise<unknown>){await fn();passed++;console.log(`PASS ${name}`);}
const eligibility=(status:UserStatus|string,vetted:boolean,blockers:string[]=[])=>new ComplianceService({} as any,{} as any,{findOne:async()=>({user:{status}})} as any,{} as any,{getBlockingReasons:async()=>blockers} as any,{isGuardVetted:async()=>vetted} as any);
async function main(){
 const states=[undefined,ScreeningStatus.NOT_STARTED,ScreeningStatus.IN_PROGRESS,ScreeningStatus.READY_FOR_REVIEW,ScreeningStatus.UNDER_REVIEW,ScreeningStatus.REQUIRES_ATTENTION,ScreeningStatus.REJECTED,ScreeningStatus.EXPIRED];
 for(const state of states) await test(`ACTIVE compliant ${state||'NO_SCREENING'} is not eligible`,async()=>assert.rejects(()=>eligibility(UserStatus.ACTIVE,false).assertGuardAssignable(1,1),/Guard screening is not complete/));
 await test('ACTIVE compliant VETTED is eligible',()=>eligibility(UserStatus.ACTIVE,true).assertGuardAssignable(1,1));
 await test('ACTIVE invalid compliance VETTED is not eligible',async()=>assert.rejects(()=>eligibility(UserStatus.ACTIVE,true,['SIA expired']).assertGuardAssignable(1,1),/SIA expired/));
 for(const state of [UserStatus.SUSPENDED,UserStatus.INACTIVE,UserStatus.PENDING,'unknown']) await test(`${state} VETTED is not eligible`,async()=>assert.rejects(()=>eligibility(state,true).assertGuardAssignable(1,1),/Guard account is not active/));
 const now=new Date('2026-03-01T00:00:00Z');
 await test('one-day gap exact',()=>assert.deepEqual(assessContinuousHistory([{startDate:'2021-03-01',endDate:'2024-01-31',isCurrent:false},{startDate:'2024-02-02',isCurrent:true}],5,now).gaps,[{from:'2024-02-01',to:'2024-02-01'}]));
 await test('leap month gap exact',()=>assert.deepEqual(assessContinuousHistory([{startDate:'2021-03-01',endDate:'2024-01-31',isCurrent:false},{startDate:'2024-03-01',isCurrent:true}],5,now).gaps,[{from:'2024-02-01',to:'2024-02-29'}]));
 await test('year boundary gap exact',()=>assert.deepEqual(assessContinuousHistory([{startDate:'2021-03-01',endDate:'2024-12-31',isCurrent:false},{startDate:'2025-01-02',isCurrent:true}],5,now).gaps,[{from:'2025-01-01',to:'2025-01-01'}]));
 await test('adjacency continuous',()=>assert.equal(assessContinuousHistory([{startDate:'2021-03-01',endDate:'2024-01-31',isCurrent:false},{startDate:'2024-02-01',isCurrent:true}],5,now).continuous,true));
 await test('beginning gap is exact',()=>assert.deepEqual(assessContinuousHistory([{startDate:'2021-04-01',isCurrent:true}],5,now).gaps,[{from:'2021-03-01',to:'2021-03-31'}]));
 await test('end gap is exact',()=>assert.deepEqual(assessContinuousHistory([{startDate:'2021-03-01',endDate:'2026-02-15',isCurrent:false}],5,now).gaps,[{from:'2026-02-16',to:'2026-03-01'}]));
 await test('multiple gaps are all returned',()=>assert.deepEqual(assessContinuousHistory([{startDate:'2021-04-01',endDate:'2023-12-31',isCurrent:false},{startDate:'2024-02-01',endDate:'2026-02-15',isCurrent:false}],5,now).gaps,[{from:'2021-03-01',to:'2021-03-31'},{from:'2024-01-01',to:'2024-01-31'},{from:'2026-02-16',to:'2026-03-01'}]));
 await test('current period covers through authoritative end',()=>assert.equal(assessContinuousHistory([{startDate:'2021-03-01',isCurrent:true}],5,now).continuous,true));
 await test('employment education and unemployment can cover full period',()=>assert.equal(assessContinuousHistory([{startDate:'2021-03-01',endDate:'2022-08-31',isCurrent:false},{startDate:'2022-09-01',endDate:'2024-06-30',isCurrent:false},{startDate:'2024-07-01',isCurrent:true}],5,now).continuous,true));
 const fs=require('fs'),path=require('path');const source=fs.readFileSync(path.join(__dirname,'../src/screening/screening.service.ts'),'utf8');
 for(const action of ['screening.check_verified','screening.consent_accepted','screening.consent_withdrawn','screening.evidence_accessed']) await test(`${action} audited`,()=>assert.ok(source.includes(action)));
 await test('evidence access audit excludes URL',()=>assert.doesNotMatch(source,/screening\.evidence_accessed[^\n]*\burl\b/));
 const entities=fs.readFileSync(path.join(__dirname,'../src/screening/entities/screening.entities.ts'),'utf8');
 await test('child screening backrefs are not eager',()=>assert.doesNotMatch(entities,/ManyToOne\(\(\) => GuardScreening[^\n]*eager\s*:\s*true/));
 const companyGuard=fs.readFileSync(path.join(__dirname,'../src/company-guard/company-guard.service.ts'),'utf8');
 await test('ACTIVE CompanyGuard invokes eligibility',()=>assert.match(companyGuard,/CompanyGuardStatus\.ACTIVE[\s\S]*assertGuardAssignable/));
 const jobs=fs.readFileSync(path.join(__dirname,'../src/job-application/job-application.service.ts'),'utf8');
 await test('application creation has no eligibility gate',()=>assert.doesNotMatch(jobs.split('async createForUser')[1].split('private async preflightHire')[0],/assertGuardAssignable/));
 await test('hire preflight precedes relationship',()=>assert.ok(jobs.indexOf('await this.preflightHire')<jobs.indexOf('await this.companyGuardService.ensureRelationship')));
 console.log(JSON.stringify({event:'screening_remediation_tests_passed',tests:passed}));
}
main().catch(e=>{console.error(e);process.exit(1);});
