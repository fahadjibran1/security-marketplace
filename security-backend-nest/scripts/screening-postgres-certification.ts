import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Company, CompanyStatus } from '../src/company/entities/company.entity';
import { CompanyGuard, CompanyGuardRelationshipType, CompanyGuardStatus } from '../src/company-guard/entities/company-guard.entity';
import { Site } from '../src/site/entities/site.entity';
import { Job, JobSourceType } from '../src/job/entities/job.entity';
import { Assignment, AssignmentStatus } from '../src/assignment/entities/assignment.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { Timesheet, TimesheetBillingStatus, TimesheetPayrollStatus, TimesheetStatus } from '../src/timesheet/entities/timesheet.entity';

function migrationClasses() {
  const directory=path.join(__dirname,'../src/database/migrations');
  return fs.readdirSync(directory).filter(f=>f.endsWith('.ts')).sort().map(file=>{
    const exports=require(path.join(directory,file));
    const migration=Object.values(exports).find((value:any)=>typeof value==='function'&&value.prototype?.up);
    if(!migration) throw new Error(`Migration export missing: ${file}`);
    return migration;
  });
}
function options(url:string,migrations:any[]):DataSourceOptions{return {type:'postgres',url,ssl:false,entities:appEntities,migrations,migrationsTableName:'typeorm_migrations',synchronize:false};}
async function main(){
  const url=process.env.SCREENING_CERT_DATABASE_URL;if(!url)throw new Error('SCREENING_CERT_DATABASE_URL is required');
  const parsed=new URL(url);if(!['127.0.0.1','localhost'].includes(parsed.hostname))throw new Error('Certification database must be local and disposable');
  const migrations=migrationClasses();if(migrations.length!==39)throw new Error(`Expected 39 migrations, found ${migrations.length}`);
  const beforeDs=new DataSource(options(url,migrations.slice(0,38)));await beforeDs.initialize();
  const initial=await beforeDs.runMigrations({transaction:'each'});if(initial.length!==38)throw new Error(`Expected 38 initial migrations, applied ${initial.length}`);
  const users=beforeDs.getRepository(User);const guards=beforeDs.getRepository(GuardProfile);const companies=beforeDs.getRepository(Company);
  const companyUser=await users.save(users.create({email:'company@sec017b.test',passwordHash:'not-a-real-login-hash',role:UserRole.COMPANY_ADMIN,status:UserStatus.ACTIVE,isEmailVerified:true}));
  const company=await companies.save(companies.create({user:companyUser,name:'SEC017B Fixture Company',companyNumber:'SEC017B',address:'Test only',contactDetails:'Test only',status:CompanyStatus.ACTIVE}));
  const guardUser1=await users.save(users.create({email:'compliant@sec017b.test',passwordHash:'not-a-real-login-hash',role:UserRole.GUARD,status:UserStatus.ACTIVE,isEmailVerified:true}));
  const guardUser2=await users.save(users.create({email:'noncompliant@sec017b.test',passwordHash:'not-a-real-login-hash',role:UserRole.GUARD,status:UserStatus.ACTIVE,isEmailVerified:true}));
  const guard1=await guards.save(guards.create({user:guardUser1,fullName:'Existing Compliant Test Guard',siaLicenseNumber:'7000000000000001',siaExpiryDate:'2030-01-01',rightToWorkStatus:'verified',rightToWorkExpiryDate:'2030-01-01',phone:'07000000001',status:'active'}));
  await guards.save(guards.create({user:guardUser2,fullName:'Existing Noncompliant Test Guard',siaLicenseNumber:'7000000000000002',siaExpiryDate:'2020-01-01',rightToWorkStatus:'expired',rightToWorkExpiryDate:'2020-01-01',phone:'07000000002',status:'active'}));
  await beforeDs.getRepository(CompanyGuard).save({company,guard:guard1,status:CompanyGuardStatus.ACTIVE,relationshipType:CompanyGuardRelationshipType.APPROVED_CONTRACTOR});
  const site=await beforeDs.getRepository(Site).save({company,name:'Fixture Site',address:'Test only',status:'active'});
  const job=await beforeDs.getRepository(Job).save({company,site,title:'Fixture Job',guardsRequired:1,hourlyRate:15,billingRate:25,status:'open',sourceType:JobSourceType.MARKETPLACE});
  const assignment=await beforeDs.getRepository(Assignment).save({company,guard:guard1,job,status:AssignmentStatus.ASSIGNED,assignedAt:new Date()});
  const shift=await beforeDs.getRepository(Shift).save({assignment,company,guard:guard1,site,job,siteName:site.name,start:new Date(Date.now()+86400000),end:new Date(Date.now()+8*3600000+86400000),status:'assigned'});
  await beforeDs.getRepository(Timesheet).save({shift,guard:guard1,company,hoursWorked:8,approvalStatus:TimesheetStatus.APPROVED,approvedMinutes:480,verifiedMinutes:480,payrollStatus:TimesheetPayrollStatus.UNPAID,billingStatus:TimesheetBillingStatus.UNINVOICED});
  const before=(await beforeDs.query(`SELECT (SELECT count(*)::int FROM users) users,(SELECT count(*)::int FROM guard_profiles) guards,(SELECT count(*)::int FROM company_guards) links,(SELECT count(*)::int FROM assignments) assignments,(SELECT count(*)::int FROM shifts) shifts,(SELECT count(*)::int FROM timesheets) timesheets,(SELECT coalesce(sum("approvedMinutes"),0)::int FROM timesheets) approved_minutes`))[0];
  await beforeDs.destroy();
  const afterDs=new DataSource(options(url,migrations));await afterDs.initialize();const applied=await afterDs.runMigrations({transaction:'each'});if(applied.length!==1)throw new Error(`Expected migration 39 only, applied ${applied.length}`);
  const count=Number((await afterDs.query(`SELECT count(*) FROM typeorm_migrations`))[0].count);const screeningCount=Number((await afterDs.query(`SELECT count(*) FROM guard_screenings`))[0].count);
  const after=(await afterDs.query(`SELECT (SELECT count(*)::int FROM users) users,(SELECT count(*)::int FROM guard_profiles) guards,(SELECT count(*)::int FROM company_guards) links,(SELECT count(*)::int FROM assignments) assignments,(SELECT count(*)::int FROM shifts) shifts,(SELECT count(*)::int FROM timesheets) timesheets,(SELECT coalesce(sum("approvedMinutes"),0)::int FROM timesheets) approved_minutes`))[0];
  assertEqual(JSON.stringify(after),JSON.stringify(before),'Representative RC1 data changed');if(screeningCount!==0)throw new Error('Migration fabricated screening records');if(count!==39)throw new Error(`Expected 39/39 migrations, found ${count}`);
  const statuses=await afterDs.query(`SELECT status FROM users ORDER BY id`);if(statuses.some((x:any)=>x.status!==UserStatus.ACTIVE))throw new Error('Existing account status changed');
  const uniqueSia=Number((await afterDs.query(`SELECT count(*) FROM pg_indexes WHERE tablename='guard_profiles' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%siaLicenseNumber%'`))[0].count);if(uniqueSia<1)throw new Error('SIA uniqueness was not preserved');
  const pending=await afterDs.runMigrations({transaction:'each'});if(pending.length!==0)throw new Error('Migrations remain pending');await afterDs.destroy();
  console.log(JSON.stringify({event:'screening_postgres_certification_passed',migrations:`${count}/39`,secondRunPending:pending.length,screeningRows:screeningCount,fixture:after,siaUnique:true}));
}
function assertEqual(actual:string,expected:string,message:string){if(actual!==expected)throw new Error(`${message}: ${actual} != ${expected}`);}
main().catch(e=>{console.error(e);process.exit(1);});
