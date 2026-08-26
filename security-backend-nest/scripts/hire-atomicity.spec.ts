import 'reflect-metadata';

import { deepEqual, equal, ok, rejects } from 'node:assert/strict';

import { JobApplicationService } from '../src/job-application/job-application.service';

type FailurePoint = 'application' | 'relationship' | 'assignment' | 'job' | 'shift' | 'timesheet';
type State = {
  applicationStatus: string;
  relationshipCount: number;
  assignmentCount: number;
  jobStatus: string;
  shiftCount: number;
  timesheetCount: number;
};

const initialState = (): State => ({
  applicationStatus: 'under_review',
  relationshipCount: 0,
  assignmentCount: 0,
  jobStatus: 'open',
  shiftCount: 0,
  timesheetCount: 0,
});

function harness(failAt?: FailurePoint) {
  let committed = initialState();
  let transactionManager: any;
  const company = { id: 10, user: { id: 100 } };
  const guard = { id: 20, user: { id: 200 } };
  const job = { id: 30, company, title: 'Pilot role', guardsRequired: 1, status: 'open' };
  const application = () => ({
    id: 40,
    job: { ...job, status: committed.jobStatus },
    guard,
    status: committed.applicationStatus,
    assignments: [],
  });

  const dataSource = {
    transaction: async (work: (manager: any) => Promise<any>) => {
      const tx = { ...committed };
      const manager = {
        tx,
        getRepository: (entity: { name: string }) => {
          if (entity.name === 'Job') {
            return {
              findOne: async () => ({ ...job, status: tx.jobStatus }),
              save: async (value: any) => (tx.jobStatus = value.status, value),
            };
          }
          if (entity.name === 'JobApplication') {
            return {
              findOne: async () => ({ ...application(), job: { ...job, status: tx.jobStatus }, status: tx.applicationStatus }),
              save: async (value: any) => {
                tx.applicationStatus = value.status;
                if (failAt === 'application') throw new Error('injected application failure');
                return value;
              },
            };
          }
          throw new Error(`unexpected repository ${entity.name}`);
        },
      };
      transactionManager = manager;
      const result = await work(manager);
      committed = tx;
      return result;
    },
  };

  const requireManager = (manager: any) => equal(manager, transactionManager, 'write escaped transaction manager');
  const service = new JobApplicationService(
    { findOne: async () => application() } as any,
    {
      save: async (value: any, manager: any) => {
        requireManager(manager);
        manager.tx.jobStatus = value.status;
        if (failAt === 'job') throw new Error('injected job failure');
        return value;
      },
    } as any,
    {} as any,
    {
      countActiveByJob: async (_jobId: number, manager: any) => {
        requireManager(manager);
        return manager.tx.assignmentCount;
      },
      createFromHire: async (_application: any, manager: any) => {
        requireManager(manager);
        manager.tx.assignmentCount += 1;
        if (failAt === 'assignment') throw new Error('injected assignment failure');
        return { id: 50, company, guard };
      },
    } as any,
    {
      create: async (_dto: any, manager: any) => {
        requireManager(manager);
        manager.tx.shiftCount += 1;
        if (failAt === 'shift') throw new Error('injected shift failure');
        manager.tx.timesheetCount += 1;
        if (failAt === 'timesheet') throw new Error('injected timesheet failure');
        return { shift: { id: 60 }, timesheet: { id: 70 } };
      },
    } as any,
    { log: async () => undefined } as any,
    { createForUser: async () => undefined } as any,
    {} as any,
    { findOne: async () => ({ id: 80, company }) } as any,
    {
      ensureRelationship: async (_params: any, manager: any) => {
        requireManager(manager);
        manager.tx.relationshipCount += 1;
        if (failAt === 'relationship') throw new Error('injected relationship failure');
        return { id: 90 };
      },
    } as any,
    { assertGuardCanTakeShift: async () => undefined } as any,
    { assertGuardAssignable: async () => undefined } as any,
    dataSource as any,
  );

  return { service, state: () => committed };
}

async function main() {
  let passed = 0;
  for (const point of ['application', 'relationship', 'assignment', 'job', 'shift', 'timesheet'] as FailurePoint[]) {
    const test = harness(point);
    await rejects(
      () => test.service.hire(40, {
        createShift: true,
        siteId: 80,
        start: '2026-09-01T09:00:00Z',
        end: '2026-09-01T17:00:00Z',
      }),
      new RegExp(`injected ${point} failure`),
    );
    deepEqual(test.state(), initialState(), `${point} failure left partial hire state`);
    passed += 1;
    console.log(`PASS ${passed}/7 ${point} failure rolls back the complete hire`);
  }

  const success = harness();
  const result = await success.service.hire(40, {
    createShift: true,
    siteId: 80,
    start: '2026-09-01T09:00:00Z',
    end: '2026-09-01T17:00:00Z',
  });
  deepEqual(success.state(), {
    applicationStatus: 'accepted',
    relationshipCount: 1,
    assignmentCount: 1,
    jobStatus: 'filled',
    shiftCount: 1,
    timesheetCount: 1,
  });
  ok(result.shiftBundle);
  passed += 1;
  console.log(`PASS ${passed}/7 successful hire commits all expected state`);
  console.log(JSON.stringify({ event: 'hire_atomicity_tests_passed', tests: passed }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
