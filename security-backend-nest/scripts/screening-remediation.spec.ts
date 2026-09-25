import 'reflect-metadata';
import * as assert from 'assert';
import { ComplianceService } from '../src/compliance/compliance.service';
import { assessContinuousHistory, normalizeUkPostcode } from '../src/screening/screening.service';
import { UserStatus } from '../src/user/entities/user.entity';
import { GuardApprovalStatus } from '../src/guard-profile/entities/guard-profile.entity';
let passed=0; async function test(name:string,fn:()=>unknown|Promise<unknown>){await fn();passed++;console.log(`PASS ${name}`);}
const eligibility=(status:UserStatus|string,blockers:string[]=[],approved=true)=>new ComplianceService({} as any,{} as any,{findOne:async()=>({user:{status},approvalStatus:approved?GuardApprovalStatus.APPROVED:GuardApprovalStatus.PENDING,isApproved:approved})} as any,{} as any,{getBlockingReasons:async()=>blockers} as any);
async function main(){
 // A company that recruited and vetted its own guard deploys them without buying S4 screening, so
 // neither the screening record nor the legacy platform-approval columns are inputs to this decision.
 await test('legacy pending GuardProfile approval no longer blocks deployment',()=>eligibility(UserStatus.ACTIVE,[],false).assertGuardAssignable(1,1));
 await test('ACTIVE guard with a clean company compliance file is eligible',()=>eligibility(UserStatus.ACTIVE).assertGuardAssignable(1,1));
 // Asserted against the source, not a fixture: the fixture can no longer express a screening state
 // at all, so the only way to show no screening state matters is to show no path exists.
 await test('no screening state and no legacy approval flag can reach assignability',()=>{
  const source=require('fs').readFileSync(require('path').join(__dirname,'../src/compliance/compliance.service.ts'),'utf8');
  const body=source.split('async assertGuardAssignable')[1].split('async getBlockingRecords')[0];
  assert.doesNotMatch(source,/this\.screeningService\.isGuardVetted/);
  assert.doesNotMatch(body,/approvalStatus/);
  assert.doesNotMatch(body,/isApproved/);
 });
 await test('ACTIVE invalid company compliance is not eligible',async()=>assert.rejects(()=>eligibility(UserStatus.ACTIVE,['SIA expired']).assertGuardAssignable(1,1),/SIA expired/));
 for(const state of [UserStatus.SUSPENDED,UserStatus.INACTIVE,UserStatus.PENDING,'unknown']) await test(`${state} account is not eligible`,async()=>assert.rejects(()=>eligibility(state).assertGuardAssignable(1,1),/Guard account is not active/));
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
 await test('UK postcode is trimmed uppercased and spaced',()=>assert.equal(normalizeUkPostcode('  bd1 1aa  '),'BD1 1AA'));
 await test('legitimate compact UK postcode is accepted',()=>assert.equal(normalizeUkPostcode('SW1A1AA'),'SW1A 1AA'));
 await test('invalid postcode is rejected',()=>assert.throws(()=>normalizeUkPostcode('not-a-postcode'),/valid UK postcode/));
 const fs=require('fs'),path=require('path');const source=fs.readFileSync(path.join(__dirname,'../src/screening/screening.service.ts'),'utf8');
 for(const action of ['screening.check_verified','screening.consent_accepted','screening.consent_withdrawn','screening.evidence_accessed']) await test(`${action} audited`,()=>assert.ok(source.includes(action)));
 await test('evidence access audit excludes URL',()=>assert.doesNotMatch(source,/screening\.evidence_accessed[^\n]*\burl\b/));
 const entities=fs.readFileSync(path.join(__dirname,'../src/screening/entities/screening.entities.ts'),'utf8');
 await test('child screening backrefs are not eager',()=>assert.doesNotMatch(entities,/ManyToOne\(\(\) => GuardScreening[^\n]*eager\s*:\s*true/));
 const companyGuard=fs.readFileSync(path.join(__dirname,'../src/company-guard/company-guard.service.ts'),'utf8');
 await test('linking a guard into a workforce runs no deployment gate',()=>assert.doesNotMatch(companyGuard,/this\.complianceService\.assertGuardAssignable/));
 const jobs=fs.readFileSync(path.join(__dirname,'../src/job-application/job-application.service.ts'),'utf8');
 await test('application creation has no eligibility gate',()=>assert.doesNotMatch(jobs.split('async createForUser')[1].split('private async preflightHire')[0],/this\.complianceService\.assertGuardAssignable/));
 await test('hire preflight precedes relationship',()=>assert.ok(jobs.indexOf('await this.preflightHire')<jobs.indexOf('await this.companyGuardService.ensureRelationship')));
 const assignment=fs.readFileSync(path.join(__dirname,'../src/assignment/assignment.service.ts'),'utf8');
 await test('hire assignment records engagement without a deployment gate',()=>assert.doesNotMatch(assignment,/this\.complianceService\.assertGuardAssignable/));
 const shift=fs.readFileSync(path.join(__dirname,'../src/shift/shift.service.ts'),'utf8');
 await test('shift creation invokes shared eligibility gate',()=>assert.match(shift,/async create\([\s\S]*assertGuardAssignable/));
 await test('shift creation asserts the ACTIVE company relationship',()=>assert.match(shift,/async create\([\s\S]*ensureActiveRelationship/));
 const availability=fs.readFileSync(path.join(__dirname,'../src/availability/availability.service.ts'),'utf8');
 await test('matching invokes shared eligibility gate',()=>assert.match(availability,/evaluateGuardForShift[\s\S]*assertGuardAssignable/));
 console.log(JSON.stringify({event:'screening_remediation_tests_passed',tests:passed}));
}
main().catch(e=>{console.error(e);process.exit(1);});
