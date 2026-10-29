import { PatrolCheckpoint } from './patrol-checkpoint.entity';
import { PatrolCheckpointVisit } from './patrol-checkpoint-visit.entity';
import { PatrolEvidence } from './patrol-evidence.entity';
import { PatrolEvidenceExport } from './patrol-evidence-export.entity';
import { PatrolEvidenceHold } from './patrol-evidence-hold.entity';
import { PatrolException } from './patrol-exception.entity';
import { PatrolPolicy } from './patrol-policy.entity';
import { PatrolRoute } from './patrol-route.entity';
import { PatrolRouteCheckpoint } from './patrol-route-checkpoint.entity';
import { PatrolRun } from './patrol-run.entity';
import { PatrolSchedule } from './patrol-schedule.entity';
import { PatrolStorageUsage } from './patrol-storage-usage.entity';
import { PatrolStorageUsageDaily } from './patrol-storage-usage-daily.entity';

export {
  PatrolCheckpoint,
  PatrolCheckpointVisit,
  PatrolEvidence,
  PatrolEvidenceExport,
  PatrolEvidenceHold,
  PatrolException,
  PatrolPolicy,
  PatrolRoute,
  PatrolRouteCheckpoint,
  PatrolRun,
  PatrolSchedule,
  PatrolStorageUsage,
  PatrolStorageUsageDaily,
};

/** Migration 68's eleven tables, plus Migration 70's evidence exports and live storage metering (P1-C). */
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
  PatrolEvidenceExport,
  PatrolStorageUsage,
];
