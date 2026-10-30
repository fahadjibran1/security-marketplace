import { PatrolCheckpoint } from './patrol-checkpoint.entity';
import { PatrolCheckpointVisit } from './patrol-checkpoint-visit.entity';
import { PatrolEvidence } from './patrol-evidence.entity';
import { PatrolEvidenceExport } from './patrol-evidence-export.entity';
import { PatrolEvidenceHold } from './patrol-evidence-hold.entity';
import { PatrolException } from './patrol-exception.entity';
import { PatrolPolicy } from './patrol-policy.entity';
import { PatrolReconciliationRun } from './patrol-reconciliation-run.entity';
import { PatrolRoute } from './patrol-route.entity';
import { PatrolRouteCheckpoint } from './patrol-route-checkpoint.entity';
import { PatrolRun } from './patrol-run.entity';
import { PatrolSchedule } from './patrol-schedule.entity';
import { PatrolStorageUsage } from './patrol-storage-usage.entity';
import { PatrolStorageUsageDaily } from './patrol-storage-usage-daily.entity';
import { PatrolSweepWatermark } from './patrol-sweep-watermark.entity';
import { PatrolSyncRecoveryGrant } from './patrol-sync-recovery-grant.entity';

export {
  PatrolCheckpoint,
  PatrolCheckpointVisit,
  PatrolEvidence,
  PatrolEvidenceExport,
  PatrolEvidenceHold,
  PatrolException,
  PatrolPolicy,
  PatrolReconciliationRun,
  PatrolRoute,
  PatrolRouteCheckpoint,
  PatrolRun,
  PatrolSchedule,
  PatrolStorageUsage,
  PatrolStorageUsageDaily,
  PatrolSweepWatermark,
  PatrolSyncRecoveryGrant,
};

/**
 * Migration 68's eleven tables, plus Migration 70's evidence exports and live storage metering (P1-C), plus Migration 71's
 * sweep watermarks and reconciliation runs (#67), plus Migration 72's sync recovery grants (issue #68).
 */
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
  PatrolSweepWatermark,
  PatrolReconciliationRun,
  PatrolSyncRecoveryGrant,
];
