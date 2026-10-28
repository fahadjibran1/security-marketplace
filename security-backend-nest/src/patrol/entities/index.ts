import { PatrolCheckpoint } from './patrol-checkpoint.entity';
import { PatrolCheckpointVisit } from './patrol-checkpoint-visit.entity';
import { PatrolEvidence } from './patrol-evidence.entity';
import { PatrolEvidenceHold } from './patrol-evidence-hold.entity';
import { PatrolException } from './patrol-exception.entity';
import { PatrolPolicy } from './patrol-policy.entity';
import { PatrolRoute } from './patrol-route.entity';
import { PatrolRouteCheckpoint } from './patrol-route-checkpoint.entity';
import { PatrolRun } from './patrol-run.entity';
import { PatrolSchedule } from './patrol-schedule.entity';
import { PatrolStorageUsageDaily } from './patrol-storage-usage-daily.entity';

export {
  PatrolCheckpoint,
  PatrolCheckpointVisit,
  PatrolEvidence,
  PatrolEvidenceHold,
  PatrolException,
  PatrolPolicy,
  PatrolRoute,
  PatrolRouteCheckpoint,
  PatrolRun,
  PatrolSchedule,
  PatrolStorageUsageDaily,
};

/** Migration 68's eleven tables. */
export const patrolEntities = [
  PatrolPolicy,
  PatrolSchedule,
  PatrolCheckpoint,
  PatrolRoute,
  PatrolRouteCheckpoint,
  PatrolRun,
  PatrolCheckpointVisit,
  PatrolEvidence,
  PatrolException,
  PatrolEvidenceHold,
  PatrolStorageUsageDaily,
];
